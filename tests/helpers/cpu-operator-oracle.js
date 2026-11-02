import * as oracle from 'onnxruntime-node';
import { kokoroOperatorFixture } from '../../scripts/lib/kokoro-operator-fixture.mjs';

export async function cpuOperator(op, inputs, output, attributes = {}, domain = '') {
  const model = kokoroOperatorFixture(op, inputs, [output], attributes, domain);
  const session = await oracle.InferenceSession.create(model, {
    executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1, graphOptimizationLevel: 'disabled',
  });
  try {
    const feeds = Object.fromEntries(inputs.filter(Boolean).map(input => [input.name,
      new oracle.Tensor(input.type === 7 ? 'int64' : 'float32', input.data, input.shape)]));
    return (await session.run(feeds))[output.name].data;
  } finally { await session.release(); }
}

export function cpuStft(signal, shape, window, frameLength, frameStep) {
  const frames = Math.floor((shape[1] - frameLength) / frameStep) + 1;
  return cpuOperator('STFT', [
    { name: 'x', type: 1, shape, data: signal },
    { name: 'step', type: 7, shape: [], data: BigInt64Array.of(BigInt(frameStep)) },
    { name: 'window', type: 1, shape: [frameLength], data: window },
    { name: 'length', type: 7, shape: [], data: BigInt64Array.of(BigInt(frameLength)) },
  ], { name: 'y', type: 1, shape: [shape[0], frames, Math.floor(frameLength / 2) + 1, 2] }, { onesided: 1 });
}
