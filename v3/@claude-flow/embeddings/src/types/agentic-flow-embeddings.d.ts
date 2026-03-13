declare module 'agentic-flow/embeddings' {
  export interface ModelInfo { id: string; dimension: number; size: string; quantized: boolean; downloaded: boolean; }
  export function getOptimizedEmbedder(opts: any): any;
  export function getNeuralSubstrate(opts?: any): any;
  export function listAvailableModels(): ModelInfo[];
  export function downloadModel(modelId: string): Promise<void>;
  export class OptimizedEmbedder { embed(text: string): Promise<Float32Array>; embedBatch(texts: string[]): Promise<Float32Array[]>; init(): Promise<void>; }
}
