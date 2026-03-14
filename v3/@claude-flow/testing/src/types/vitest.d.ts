declare module 'vitest' {
  export function describe(name: string, fn: () => void): void;

  interface ItFunction {
    (name: string, fn: () => void | Promise<void>): void;
    each<T>(cases: T[]): (name: string, fn: (...args: T extends readonly (infer U)[] ? U[] : [T]) => void | Promise<void>) => void;
  }

  export const it: ItFunction;
  export const test: ItFunction;

  interface ExpectFunction {
    (value: any): any;
    extend(matchers: Record<string, (...args: any[]) => { pass: boolean; message: () => string }>): void;
    any(constructor: any): any;
    anything(): any;
    arrayContaining(arr: any[]): any;
    objectContaining(obj: Record<string, any>): any;
    stringContaining(str: string): any;
    stringMatching(pattern: string | RegExp): any;
  }

  export const expect: ExpectFunction;
  export type ExpectStatic = ExpectFunction;

  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function beforeAll(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;

  export const vi: {
    fn: (...args: any[]) => any;
    spyOn: (...args: any[]) => any;
    mock: (...args: any[]) => any;
    mocked: <T>(item: T) => any;
    resetAllMocks: () => void;
    clearAllMocks: () => void;
    restoreAllMocks: () => void;
    useFakeTimers: () => void;
    useRealTimers: () => void;
    setSystemTime: (time: number | Date) => void;
    advanceTimersByTime: (ms: number) => void;
    runAllTimers: () => void;
    runOnlyPendingTimers: () => void;
  };

  export type Mock<T = any> = T & {
    mock: {
      calls: any[][];
      results: any[];
      instances: any[];
      invocationCallOrder: number[];
      lastCall: any[];
    };
    mockReturnValue: (val: any) => Mock<T>;
    mockReturnValueOnce: (val: any) => Mock<T>;
    mockResolvedValue: (val: any) => Mock<T>;
    mockResolvedValueOnce: (val: any) => Mock<T>;
    mockRejectedValue: (val: any) => Mock<T>;
    mockRejectedValueOnce: (val: any) => Mock<T>;
    mockImplementation: (fn: any) => Mock<T>;
    mockImplementationOnce: (fn: any) => Mock<T>;
    getMockImplementation: () => ((...args: any[]) => any) | undefined;
    mockClear: () => Mock<T>;
    mockReset: () => Mock<T>;
    mockRestore: () => void;
  };

  // Vitest module augmentation for custom matchers
  interface Assertion<T = any> {}
  interface AsymmetricMatchersContaining {}
}

// Module declarations for sibling packages resolved via project references
declare module '@claude-flow/memory' {
  export class UnifiedMemoryService {
    constructor(config?: any);
    initialize(): Promise<void>;
    store(key: string, value: any, metadata?: any): Promise<void>;
    storeEntry(entry: any): Promise<any>;
    retrieve(key: string): Promise<any>;
    get(id: string): Promise<any>;
    search(query: any, options?: any): Promise<any[]>;
    delete(key: string): Promise<void>;
    close(): Promise<void>;
    shutdown(): Promise<void>;
  }
  export class HybridBackend {
    constructor(config?: any);
    initialize(): Promise<void>;
    store(key: string, value: any, metadata?: any): Promise<void>;
    retrieve(key: string): Promise<any>;
    search(query: any): Promise<any[]>;
    delete(key: string): Promise<void>;
    close(): Promise<void>;
    getStats(): Promise<any>;
  }
  export const MEMORY_VERSION: string;
}

declare module '@claude-flow/shared' {
  export class EventBus {
    constructor();
    publish(event: any): void;
    emit(event: any): Promise<void>;
    subscribe(pattern: string, handler: (event: any) => void): () => void;
  }
  export class Logger {
    constructor(name?: string);
    info(message: string, ...args: any[]): void;
    warn(message: string, ...args: any[]): void;
    error(message: string, ...args: any[]): void;
    debug(message: string, ...args: any[]): void;
  }
  export class HookRegistry {
    constructor();
    register(hook: any, handler: (...args: any[]) => any, priority?: any): string;
    unregister(hookId: string): void;
    getHook(hookId: string): any;
    getHooks(hook: any): any[];
    getHandlers(hook: any): any[];
  }
  export const HookPriority: {
    Low: number;
    Normal: number;
    High: number;
    Critical: number;
  };
  export function createId(): string;
  export function generateSecureId(): string;
  export function createAgentSpawnedEvent(agentId: string, agentType: string, swarmId: string, capabilities: string[]): any;
  export function validateConfig(config: any): { valid: boolean; errors?: string[] };
  export const SHARED_VERSION: string;
}

declare module '@claude-flow/swarm' {
  export class UnifiedSwarmCoordinator {
    constructor(config?: any);
    initialize(): Promise<void>;
    coordinate(agents: string[], task: any): Promise<any>;
    shutdown(graceful?: boolean): Promise<void>;
    addAgent(agentId: string): Promise<void>;
    removeAgent(agentId: string): Promise<void>;
    getState(): any;
    getStatus(): any;
  }
  export const SWARM_VERSION: string;
}
