declare module '@ruvector/attention' {
  export interface AttentionConfig { dim: number; numHeads?: number; dropout?: number; blockSize?: number; }
  export function scaledDotProductAttention(q: Float32Array, k: Float32Array[], v: Float32Array[]): Float32Array;
  export function multiHeadAttention(q: Float32Array, k: Float32Array[], v: Float32Array[], c: AttentionConfig): Float32Array;
  export function flashAttention(q: Float32Array, k: Float32Array[], v: Float32Array[], bs?: number): Float32Array;
  export function hyperbolicAttention(q: Float32Array, k: Float32Array[], v: Float32Array[], c?: number): Float32Array;
  export class FlashAttention { constructor(dim: number, blockSize?: number); compute(q: Float32Array, k: Float32Array[], v: Float32Array[]): Float32Array; computeRaw(q: Float32Array, k: Float32Array[], v: Float32Array[]): Float32Array; }
  export class DotProductAttention { constructor(dim: number); compute(q: Float32Array, k: Float32Array[], v: Float32Array[]): Float32Array; computeRaw(q: Float32Array, k: Float32Array[], v: Float32Array[]): Float32Array; }
  export class MultiHeadAttention { constructor(dim: number, heads?: number); compute(q: Float32Array, k: Float32Array[], v: Float32Array[]): Float32Array; computeRaw(q: Float32Array, k: Float32Array[], v: Float32Array[]): Float32Array; }
  export class LinearAttention { constructor(dim: number); compute(q: Float32Array, k: Float32Array[], v: Float32Array[]): Float32Array; computeRaw(q: Float32Array, k: Float32Array[], v: Float32Array[]): Float32Array; }
  export class HyperbolicAttention { constructor(dim: number, curvature?: number); compute(q: Float32Array, k: Float32Array[], v: Float32Array[]): Float32Array; }
  export class MoEAttention { constructor(dim: number, numExperts?: number); compute(q: Float32Array, k: Float32Array[], v: Float32Array[]): Float32Array; }
  export class InfoNceLoss { constructor(config?: any); compute(a: Float32Array[], p: Float32Array[], n?: Float32Array[]): number; }
  export class AdamWOptimizer { constructor(config?: any); step(p: Float32Array, g: Float32Array): Float32Array; }
  export function benchmarkAttention(config: any): any;
  export const version: string;
}
