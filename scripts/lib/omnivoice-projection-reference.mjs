// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Independent development oracle, isolated from the previously released large-model session.
self.onmessage = async ({ data: { primitive, activation, weightBits, m, k, n } }) => {
  let session; const inputs = {};
  try {
    const runtimeModule = '/runtime/ort.webgpu.bundle.min.mjs', ort = await import(runtimeModule);
    ort.env.wasm.numThreads = 1; ort.env.wasm.wasmPaths = `${location.origin}/runtime/`; ort.env.logLevel = 'error';
    session = await ort.InferenceSession.create(primitive, { executionProviders: ['webgpu'], graphOptimizationLevel: 'disabled', logSeverityLevel: 3 });
    inputs.a = new ort.Tensor('float16', activation, [m, k]); inputs.b = new ort.Tensor('float16', weightBits, [k, n]);
    const output = (await session.run(inputs, ['y'])).y;
    try {
      const data = await output.getData(); if (output.type !== 'float16' || data.byteLength !== output.size * 2) throw new Error('Unexpected reference projection storage.');
      const bits = new Uint16Array(new Uint16Array(data.buffer, data.byteOffset, output.size));
      self.postMessage({ bits }, [bits.buffer]);
    } finally { output.dispose(); }
  } catch (error) { self.postMessage({ error: String(error?.stack || error) }); }
  finally { for (const tensor of Object.values(inputs)) tensor.dispose(); await session?.release(); }
};
