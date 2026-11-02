import oracle from '../../scripts/lib/node-onnx-oracle.mjs';
import { kokoroOperatorFixture } from '../../scripts/lib/kokoro-operator-fixture.mjs';

const model = kokoroOperatorFixture('Relu', [{ name: 'x', type: 1, shape: [4] }], [{ name: 'y', type: 1, shape: [4] }]);
const session = await oracle.InferenceSession.create(model, { executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1, graphOptimizationLevel: 'disabled' });
const x = new oracle.Tensor('float32', Float32Array.of(-1, 0, 1, 2), [4]);
let result;
try {
  result = await session.run({ x });
  console.log(JSON.stringify({ telemetryDisabled: process.env.ORT_DISABLE_TELEMETRY, values: [...result.y.data] }));
} finally {
  result?.y.dispose(); x.dispose(); await session.release();
}
