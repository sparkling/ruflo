/**
 * Daemon IPC — Unix domain socket server + client for hook<->daemon communication.
 * ADR-0059 Phase 4: Hooks delegate memory writes to the daemon (single writer).
 * Fallback: if daemon is not running, hooks write RVF directly (Phase 1 behavior).
 *
 * Protocol: newline-delimited JSON-RPC 2.0 over Unix domain socket.
 * Socket path: .claude-flow/daemon.sock (owner-only permissions, mode 0600).
 */

import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ===== Types =====

interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
  id: number | string;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id: number | string | null;
}

export interface DaemonIPCConfig {
  socketPath: string;
  projectRoot: string;
}

export const DAEMON_SOCKET_FILENAME = 'daemon.sock';

export function getDaemonSocketPath(projectRoot: string): string {
  return path.join(projectRoot, '.claude-flow', DAEMON_SOCKET_FILENAME);
}

// ===== Server =====

type MethodHandler = (params: Record<string, unknown>) => Promise<unknown>;

export class DaemonIPCServer {
  private server: net.Server | null = null;
  private connections = new Set<net.Socket>();
  private handlers = new Map<string, MethodHandler>();
  private _running = false;
  private config: DaemonIPCConfig;

  constructor(config: DaemonIPCConfig) {
    this.config = config;
  }

  get isRunning(): boolean {
    return this._running;
  }

  get socketPath(): string {
    return this.config.socketPath;
  }

  /**
   * Register an RPC method handler.
   */
  registerMethod(method: string, handler: MethodHandler): void {
    this.handlers.set(method, handler);
  }

  /**
   * Start listening on the Unix domain socket.
   */
  async start(): Promise<void> {
    // Clean up stale socket file
    if (fs.existsSync(this.config.socketPath)) {
      try { fs.unlinkSync(this.config.socketPath); } catch { /* ignore */ }
    }

    // Ensure directory exists
    const dir = path.dirname(this.config.socketPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    return new Promise<void>((resolve, reject) => {
      this.server = net.createServer((socket) => this.handleConnection(socket));

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          // Stale socket — remove and retry once
          try { fs.unlinkSync(this.config.socketPath); } catch { /* ignore */ }
          this.server!.listen(this.config.socketPath, () => {
            this.setSocketPermissions();
            this._running = true;
            resolve();
          });
        } else {
          reject(err);
        }
      });

      this.server.listen(this.config.socketPath, () => {
        this.setSocketPermissions();
        this._running = true;
        resolve();
      });
    });
  }

  /**
   * Stop the IPC server and clean up.
   */
  async stop(): Promise<void> {
    this._running = false;

    // Close all tracked connections
    for (const socket of this.connections) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
    this.connections.clear();

    // Close server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    // Remove socket file
    try { fs.unlinkSync(this.config.socketPath); } catch { /* ignore */ }
  }

  private setSocketPermissions(): void {
    try {
      fs.chmodSync(this.config.socketPath, 0o600);
    } catch {
      // Non-fatal on platforms that don't support chmod on sockets
    }
  }

  private handleConnection(socket: net.Socket): void {
    this.connections.add(socket);
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue;
        this.processMessage(socket, line.trim());
      }
    });

    socket.on('close', () => {
      this.connections.delete(socket);
    });

    socket.on('error', () => {
      this.connections.delete(socket);
    });
  }

  private async processMessage(socket: net.Socket, raw: string): Promise<void> {
    let id: number | string | null = null;
    try {
      const req: JsonRpcRequest = JSON.parse(raw);
      id = req.id;

      if (req.jsonrpc !== '2.0' || !req.method) {
        this.sendError(socket, id, -32600, 'Invalid Request');
        return;
      }

      const handler = this.handlers.get(req.method);
      if (!handler) {
        this.sendError(socket, id, -32601, `Method not found: ${req.method}`);
        return;
      }

      const result = await handler(req.params || {});
      this.sendResult(socket, id, result);
    } catch (err: any) {
      if (err instanceof SyntaxError) {
        this.sendError(socket, id, -32700, 'Parse error');
      } else {
        this.sendError(socket, id, -32603, err.message || 'Internal error');
      }
    }
  }

  private sendResult(socket: net.Socket, id: number | string | null, result: unknown): void {
    const resp: JsonRpcResponse = { jsonrpc: '2.0', result, id };
    try { socket.write(JSON.stringify(resp) + '\n'); } catch { /* socket closed */ }
  }

  private sendError(socket: net.Socket, id: number | string | null, code: number, message: string): void {
    const resp: JsonRpcResponse = { jsonrpc: '2.0', error: { code, message }, id };
    try { socket.write(JSON.stringify(resp) + '\n'); } catch { /* socket closed */ }
  }
}

// ADR-0088: client class removed. It had zero in-tree callers and contradicted
// ADR-050 (hot path is file-based, no daemon). The server class above remains
// for future non-memory RPC methods; memory ops are in-process only via
// memory-router.ts per ADR-0086.
