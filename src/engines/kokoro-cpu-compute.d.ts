export class WasmKokoroCompute {
  static create(bytes: BufferSource, options?: {maxBytes?: number}): Promise<WasmKokoroCompute>;
  createKokoroKernels(): unknown;
  dispose(): Promise<void>;
}
