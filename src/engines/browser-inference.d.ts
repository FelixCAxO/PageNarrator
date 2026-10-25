export class Tensor {
  constructor(type: 'float32', data: Float32Array, dims: readonly number[]);
  constructor(type: 'int64', data: BigInt64Array, dims: readonly number[]);
  constructor(type: 'int32', data: Int32Array, dims: readonly number[]);
  constructor(type: 'float16', data: Uint16Array, dims: readonly number[]);
  constructor(type: 'bool', data: Uint8Array, dims: readonly number[]);
  constructor(type: 'uint8', data: Uint8Array, dims: readonly number[]);
  constructor(type: 'int8', data: Int8Array, dims: readonly number[]);
  readonly type: 'float32' | 'int64' | 'int32' | 'float16' | 'bool' | 'uint8' | 'int8';
  readonly dims: readonly number[];
  readonly size: number;
  data: Float32Array | BigInt64Array | Int32Array | Uint16Array | Uint8Array | Int8Array | null;
  getData(): Promise<Float32Array | BigInt64Array | Int32Array | Uint16Array | Uint8Array | Int8Array>;
  dispose(): void;
}

export class InferenceSession {
  private constructor();
  static create(source: ArrayBuffer | Uint8Array | string | URL, options?: {
    executionProviders?: string[];
    maxPlanBytes?: number;
    maxCachedPlans?: 1 | 2;
    engine?: unknown;
    externalData?: {path: string; data: ArrayBuffer | Uint8Array}[];
    releaseHostWeights?: boolean;
  }): Promise<InferenceSession>;
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, Tensor>, outputNames?: readonly string[]): Promise<Record<string, Tensor>>;
  release(): Promise<void>;
  getDiagnostics(): unknown;
}

export function createBrowserInferenceEngine(options?: { float16?: boolean }): {
  Tensor: typeof Tensor;
  InferenceSession: Pick<typeof InferenceSession, 'create'>;
  dispose(): Promise<void>;
};
