declare module 'vitest' {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function expect(value: any): any;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function beforeAll(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;
  export const vi: { fn: (...args: any[]) => any; spyOn: (...args: any[]) => any; mock: (...args: any[]) => any; mocked: <T>(item: T) => any; resetAllMocks: () => void; clearAllMocks: () => void; restoreAllMocks: () => void; };
  export type Mock<T = any> = T & { mockReturnValue: (val: any) => Mock<T>; mockResolvedValue: (val: any) => Mock<T>; mockImplementation: (fn: any) => Mock<T>; mockRejectedValue: (val: any) => Mock<T>; };
}
