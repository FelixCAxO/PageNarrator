import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

afterEach(() => { vi.doUnmock('onnxruntime-node'); vi.unstubAllEnvs(); vi.resetModules(); });

it.each([undefined, '0'])('suppresses telemetry before loading the native runtime, even with initial opt-out %s', async initial => {
  vi.resetModules(); vi.stubEnv('ORT_DISABLE_TELEMETRY', initial);
  const native = { InferenceSession: class {}, Tensor: class {}, env: {} };
  vi.doMock('onnxruntime-node', () => {
    expect(process.env.ORT_DISABLE_TELEMETRY).toBe('1');
    return native;
  });
  const { default: oracle } = await import('../../scripts/lib/node-onnx-oracle.mjs');
  expect(oracle.InferenceSession).toBe(native.InferenceSession);
  expect(oracle.Tensor).toBe(native.Tensor); expect(oracle.env).toBe(native.env);
});

it('runs real native inference and exits naturally after disposing the session', async () => {
  const fixture = fileURLToPath(new URL('../helpers/node-oracle-shutdown.mjs', import.meta.url));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture], { env: { ...process.env, ORT_DISABLE_TELEMETRY: '0', ORT_RUNNING_UNIT_TESTS: '0' }, windowsHide: true });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Native oracle failed to exit: ${stderr}`)); }, 10000);
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stdout, stderr }); });
  });
  expect(result).toMatchObject({ code: 0, signal: null, stderr: '' });
  expect(JSON.parse(result.stdout)).toEqual({ telemetryDisabled: '1', values: [0, 0, 1, 2] });
}, 15000);
