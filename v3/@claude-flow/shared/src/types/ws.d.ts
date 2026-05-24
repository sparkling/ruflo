// Ambient stub for ws — WebSocket transport.
// Local package stub satisfies tsc when @types/ws isn't hoisted.
//
// WebSocket is exported as a class (default + named). We declare it as a
// class to provide both a value (for `new WebSocket(...)`) and a type
// (for `Set<WebSocket>`) without colliding with the DOM lib's `WebSocket`
// global — the named-export shape mirrors @types/ws's real shape, which
// `isolatedModules` is happy to import with a side-by-side identifier.
declare module 'ws' {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  class WebSocket {
    constructor(...args: any[]);
    [key: string]: any;
    static readonly CONNECTING: 0;
    static readonly OPEN: 1;
    static readonly CLOSING: 2;
    static readonly CLOSED: 3;
  }
  class WebSocketServer {
    constructor(...args: any[]);
    [key: string]: any;
  }
  export = WebSocket;
  export { WebSocket, WebSocketServer };
  export type Server = WebSocketServer;
  export type ServerOptions = any;
  export type RawData = any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
