import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { Tensor, InferenceSession } from '../../src/engines/browser-inference.js';
import { WasmKokoroCompute } from '../../src/engines/kokoro-cpu-compute.js';
import { WebGpuOnnxSession } from '../../src/engines/webgpu-onnx-session.js';
import { kokoroOperatorFixture } from '../../scripts/lib/kokoro-operator-fixture.mjs';

it.each([[9, 'bool', 'uint8'], [2, 'uint8', 'bool']])(
  'preserves the logical %s input contract despite identical byte storage', async (onnxType, expected, wrong) => {
    const engine = await WasmKokoroCompute.create(await readFile(new URL('../../public/native/kokoro-engine.wasm', import.meta.url)));
    let session, output;
    const actual = new Tensor(expected, Uint8Array.of(0, 1), [2]), mismatch = new Tensor(wrong, Uint8Array.of(0, 1), [2]);
    try {
      const model = kokoroOperatorFixture('Cast', [{ name: 'x', type: onnxType, shape: [2] }],
        [{ name: 'y', type: onnxType, shape: [2] }], { to: onnxType });
      session = new InferenceSession(await WebGpuOnnxSession.create(model, { engine }));
      await expect(session.run({ x: mismatch })).rejects.toThrow(/type/);
      output = (await session.run({ x: actual })).y;
      expect(output.type).toBe(expected);
      expect(output.data).toEqual(Uint8Array.of(0, 1));
    } finally {
      actual.dispose(); mismatch.dispose(); output?.dispose(); await session?.release();
      expect(engine.buffers.size).toBe(0); expect(engine.tensors.size).toBe(0);
      await engine.dispose();
    }
  },
);
