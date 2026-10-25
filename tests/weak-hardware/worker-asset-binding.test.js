import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { annotateProbeWorker, readKokoroWorkerAssets, trackProbeWorkerTargets } from '../live/tts-probe-browser-session.js';

const roots = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const coordinatorLiteral = 'new Worker(new URL(""+new URL("worker-A1.js",import.meta.url).href,import.meta.url),{type:"module"})';
const helperLiteral = 'new Worker(new URL(""+new URL("cpu-pool-worker-B2.js",import.meta.url).href,import.meta.url),{type:"module"})';
async function fixture(source = `${coordinatorLiteral};${helperLiteral}`) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pn-worker-assets-'));
  roots.push(root); await mkdir(path.join(root, 'assets'));
  for (const [file, bytes] of [['worker-client.js', source], ['worker-A1.js', '// coordinator'], ['cpu-pool-worker-B2.js', '// helper']]) {
    await writeFile(path.join(root, 'assets', file), bytes);
  }
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root), prefix = path.join(path.resolve(os.tmpdir()), 'pn-worker-assets-');
    if (!resolved.startsWith(prefix)) throw new Error('Refusing cleanup outside the owned worker fixture.');
    await rm(resolved, { recursive: true, force: true });
  }
});

it('binds the two built worker URLs to the actual module and worker bytes', async () => {
  const root = await fixture(), result = await readKokoroWorkerAssets(root);
  expect(result).toEqual({ asset: 'assets/worker-client.js', coordinatorPath: 'assets/worker-A1.js', helperPath: 'assets/cpu-pool-worker-B2.js',
    sha256: hash(await readFile(path.join(root, 'assets/worker-client.js'))), coordinatorSha256: hash(Buffer.from('// coordinator')), helperSha256: hash(Buffer.from('// helper')) });
});

it('accepts explicit current-directory worker filenames', async () => {
  const root = await fixture(`${coordinatorLiteral.replace('worker-A1.js', './worker-A1.js')};${helperLiteral}`);
  expect(await readKokoroWorkerAssets(root)).toMatchObject({ coordinatorPath: 'assets/worker-A1.js', helperPath: 'assets/cpu-pool-worker-B2.js' });
});

it.each([
  ['ambiguous coordinator', `${coordinatorLiteral};${coordinatorLiteral};${helperLiteral}`],
  ['missing helper literal', coordinatorLiteral],
  ['foreign origin', `${coordinatorLiteral.replace('worker-A1.js', 'https://foreign.invalid/assets/worker-A1.js')};${helperLiteral}`],
  ['synthetic-origin absolute URL', `${coordinatorLiteral.replace('worker-A1.js', 'https://packaged.invalid/assets/worker-A1.js')};${helperLiteral}`],
  ['protocol-relative URL', `${coordinatorLiteral.replace('worker-A1.js', '//packaged.invalid/assets/worker-A1.js')};${helperLiteral}`],
  ['outside asset directory', `${coordinatorLiteral.replace('worker-A1.js', '../worker-A1.js')};${helperLiteral}`],
  ['query-bearing URL', `${coordinatorLiteral.replace('worker-A1.js', 'worker-A1.js?other=1')};${helperLiteral}`],
])('refuses an unbound packaged worker role: %s', async (_name, source) => {
  await expect(readKokoroWorkerAssets(await fixture(source))).rejects.toThrow(/Cannot identify the packaged Kokoro/);
});

it('refuses a bundle reference whose worker artifact is absent', async () => {
  const root = await fixture(); await rm(path.join(root, 'assets/worker-A1.js'));
  await expect(readKokoroWorkerAssets(root)).rejects.toMatchObject({ code: 'ENOENT' });
});

const binding = { coordinatorUrl: 'chrome-extension://x/assets/worker-A1.js', helperUrl: 'chrome-extension://x/assets/cpu-pool-worker-B2.js', sha256: 'frozen-module-sha' };
it('attributes only exact dedicated worker URLs and overwrites target-supplied roles', () => {
  expect(annotateProbeWorker({ type: 'worker', url: binding.coordinatorUrl }, binding)).toMatchObject({ pagenarratorRole: 'kokoro-coordinator', workerBindingSha256: binding.sha256 });
  expect(annotateProbeWorker({ type: 'worker', url: binding.helperUrl }, binding).pagenarratorRole).toBe('kokoro-cpu-helper');
  for (const target of [
    { type: 'worker', title: 'pn-kokoro-cpu-1-1', url: 'chrome-extension://x/assets/worker-other.js', pagenarratorRole: 'kokoro-coordinator' },
    { type: 'service_worker', url: binding.coordinatorUrl },
    { type: 'worker', url: binding.coordinatorUrl.replace('://x/', '://other-extension/') },
  ]) expect(annotateProbeWorker(target, binding).pagenarratorRole).toBeNull();
  expect(annotateProbeWorker({ type: 'worker', url: binding.coordinatorUrl }, null).pagenarratorRole).toBeNull();
});

it('removes detached pool targets before counting a later serial coordinator', () => {
  const callbacks = new Map(), cdp = { on: (event, callback) => callbacks.set(event, callback) };
  const workers = new Map([['reader', []]]);
  trackProbeWorkerTargets(cdp, workers, () => binding);
  const attached = callbacks.get('Target.attachedToTarget'), detached = callbacks.get('Target.detachedFromTarget');
  attached({ sessionId: 'old-main', targetInfo: { type: 'worker', url: binding.coordinatorUrl } }, 'reader');
  attached({ sessionId: 'old-helper', targetInfo: { type: 'worker', url: binding.helperUrl } }, 'reader');
  attached({ sessionId: 'ignored', targetInfo: { type: 'worker', url: binding.helperUrl } }, 'other-page');
  expect(workers.get('reader')).toHaveLength(2);
  detached({ sessionId: 'old-main' }); detached({ sessionId: 'old-helper' });
  attached({ sessionId: 'new-main', targetInfo: { type: 'worker', url: binding.coordinatorUrl } }, 'reader');
  expect(workers.get('reader')).toEqual([expect.objectContaining({ sessionId: 'new-main', pagenarratorRole: 'kokoro-coordinator' })]);
  detached({ sessionId: 'not-attached' }); detached({});
  expect(workers.get('reader')).toHaveLength(1);
});
