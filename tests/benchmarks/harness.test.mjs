import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureGate, inspectWav } from '../../scripts/benchmarks/measure.mjs';

function wav(amplitude = 1000) {
  const b = Buffer.alloc(48);
  b.write('RIFF'); b.writeUInt32LE(40, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36);
  b.writeUInt32LE(4, 40); b.writeInt16LE(amplitude, 44);
  return b;
}
const valid = { launched: true, supported: true, modelAvailable: true,
  requestedBackend: 'webgpu', observedBackend: 'webgpu', audio: wav(),
  complete: true, attributable: true, speechVerified: true };

await test('negative controls cannot pass the capture gate', () => {
  for (const [override, status, reason] of [
    [{ audio: null }, 'failed', /Missing audio/],
    [{ launched: false }, 'blocked', /Launch/],
    [{ audio: wav(0) }, 'failed', /Silent/],
    [{ audio: wav().subarray(0, 46) }, 'failed', /Truncated WAV/],
    [{ complete: false }, 'failed', /Truncated speech/],
    [{ observedBackend: 'wasm' }, 'failed', /Backend mismatch/],
    [{ modelAvailable: false }, 'blocked', /Model unavailable/],
    [{ contentTransmissionObserved: true }, 'failed', /transmission/],
    [{ supported: false }, 'unsupported', /unsupported/],
    [{ attributable: false }, 'not_measured', /evidence/],
    [{ speechVerified: undefined }, 'not_measured', /evidence/],
    [{ observedBackend: null }, 'not_measured', /evidence/],
  ]) {
    const result = captureGate({ ...valid, ...override });
    assert.equal(result.status, status); assert.match(result.reason, reason);
  }
  assert.equal(captureGate(valid).status, 'passed');
  assert.equal(inspectWav(wav()).firstSignalSeconds, 0);
  assert.equal(inspectWav(wav(0)).firstSignalSeconds, null);
});
