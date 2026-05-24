/**
 * Minimal WebAssembly type augmentation for quantum-optimizer.
 *
 * The quantum-optimizer's own tsconfig has `lib: ["ES2022", "DOM"]` so it
 * resolves `WebAssembly.Memory` correctly when built in isolation. But the
 * fork root tsconfig (`v3/**\/*.ts`) uses `lib: ["ES2022"]` (no DOM,
 * no WebWorker), so the same files fail at the global build pass.
 *
 * Declare only what bridges/{dag,exotic}-bridge.ts need: `WebAssembly.Memory`
 * as both a type (interface) and a constructor (value). Anything wider is out
 * of scope for this fix.
 */
declare namespace WebAssembly {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Memory { readonly buffer: ArrayBuffer; grow(delta: number): number; [key: string]: any; }
  interface MemoryDescriptor { initial: number; maximum?: number; shared?: boolean; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Memory: { new (descriptor: MemoryDescriptor): Memory; readonly prototype: Memory };
}
