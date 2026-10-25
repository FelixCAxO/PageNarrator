// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Development-only independent CPU oracle. No downloaded or production runtime.
import { createHash } from 'node:crypto';

export async function createNodeOcrReference(model, { runtime = null } = {}) {
  const ort = runtime || await import('onnxruntime-node');
  const session = await ort.InferenceSession.create(model, { executionProviders: ['cpu'],
    intraOpNumThreads: 1, interOpNumThreads: 1, graphOptimizationLevel: 'disabled', logSeverityLevel: 3 });
  if (session.inputNames.length !== 1 || !session.outputNames.length) {
    await session.release();
    throw new Error('Node OCR reference requires one detector input and declared outputs.');
  }
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  return {
    inputNames: session.inputNames,
    outputNames: session.outputNames,
    async run({ shape, base64 }) {
      if (!Array.isArray(shape) || shape.length !== 4 || shape.some(value => !Number.isSafeInteger(value) || value <= 0)
        || shape.reduce((a, b) => a * b, 1) > 8 * 1024 * 1024 || typeof base64 !== 'string' || base64.length > 48 * 1024 * 1024) {
        throw new Error('Invalid Node OCR reference float32 input shape or payload.');
      }
      const raw = Buffer.from(base64, 'base64');
      if (raw.length !== shape.reduce((a, b) => a * b, 1) * 4 || raw.toString('base64') !== base64) {
        throw new Error('Node OCR reference bytes do not match the input shape.');
      }
      const data = new Float32Array(Uint8Array.from(raw).buffer);
      const input = new ort.Tensor('float32', data, shape);
      let outputs;
      try {
        outputs = await session.run({ [session.inputNames[0]]: input });
        const result = {};
        for (const name of session.outputNames) {
          const tensor = outputs[name];
          if (tensor?.type !== 'float32' || !(tensor.data instanceof Float32Array)
            || tensor.dims.reduce((a, b) => a * b, 1) !== tensor.data.length) throw new Error('Node OCR reference returned an invalid float32 output.');
          const bytes = Buffer.from(tensor.data.buffer, tensor.data.byteOffset, tensor.data.byteLength);
          result[name] = { shape: tensor.dims, base64: bytes.toString('base64'), sha256: hash(bytes) };
        }
        return { inputSha256: hash(raw), outputs: result };
      } finally {
        input.dispose();
        for (const tensor of Object.values(outputs || {})) tensor.dispose();
      }
    },
    release: () => session.release(),
  };
}
