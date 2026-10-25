import { afterEach, describe, expect, it, vi } from 'vitest';
import { supportsKokoroCpuPool, createKokoroCpuPoolOwner } from '../../src/tts/kokoro/cpu-pool.js';
import { createKokoroWorkerBackend } from '../../src/tts/kokoro/worker-client.js';
import { kokoroCpuPoolLayout, kokoroCpuRowRanges } from '../../src/tts/kokoro/parallel-compute.js';

const capabilities = { crossOriginIsolated: true, SharedArrayBuffer, Atomics, navigator: { hardwareConcurrency: 4 } };
const module = new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
const imports = [{ module: 'env', name: 'memory', kind: 'memory' }];
const fixtures = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.dispose(); vi.restoreAllMocks(); });

function boot(generation) {
  const layout = kokoroCpuPoolLayout(70000), memory = new WebAssembly.Memory({ initial: 16, maximum: 8192, shared: true });
  return { type: 'start', generation, abi: 0x504e5201, module, memory, layout,
    scratch: Array.from({ length: 3 }, (_, i) => ({ offset: layout.base + i * 209280, size: 209280 })) };
}

async function client({ startupFailure = false, pendingGeneration = false, stallReopen = false, scope = capabilities } = {}) {
  vi.spyOn(WebAssembly.Module, 'imports').mockReturnValue(imports);
  const workers = [], helpers = [], requests = [];
  const createWorker = () => {
    const worker = { terminated: false, terminate: vi.fn(() => { worker.terminated = true; }), postMessage: vi.fn(data => {
      requests.push(data);
      const reply = result => queueMicrotask(() => { if (!worker.terminated) worker.onmessage({ data: result }); });
      if (data.method === 'init') {
        worker.init = data;
        if (data.cpuParallel) reply({ cpuPool: startupFailure ? { type: 'failed', generation: data.cpuGeneration, message: 'Unsupported shared memory.' } : boot(data.cpuGeneration) });
        else reply({ id: data.id, result: { voices: { af_heart: {} }, modelInfo: { serial: true } } });
      } else if (data.cpuPool?.type === 'ready') reply({ id: worker.init.id, result: { voices: { af_heart: {} }, modelInfo: { serial: false } } });
      else if (data.method === 'generate' && !pendingGeneration) reply({ id: data.id, result: { audio: Float32Array.of(.25), sampling_rate: 24000 } });
      else if (data.method === 'prepareVoice') reply({ id: data.id, result: { prepared: true } });
    }) };
    workers.push(worker); return worker;
  };
  const createHelper = (slot, generation) => {
    const helper = { terminate: vi.fn(), postMessage: vi.fn(() => {
      if (!stallReopen || workers.length === 1) queueMicrotask(() => helper.onmessage({ data: { cpuPool: { type: 'ready', slot, generation, shared: true, isolated: true } } }));
    }) };
    helpers.push(helper); return helper;
  };
  const tts = await createKokoroWorkerBackend('model', { device: 'wasm', dtype: 'q8', capabilities: scope, createWorker, createHelper,
    runtime: { getURL: path => `chrome-extension://test/${path}` } });
  fixtures.push(tts); return { tts, workers, helpers, requests };
}

describe('optional original CPU worker ownership', () => {
  it('requires actual isolation, shared-memory primitives and at least four reported cores', () => {
    expect(supportsKokoroCpuPool(capabilities)).toBe(true);
    for (const changed of [{ crossOriginIsolated: false }, { SharedArrayBuffer: undefined }, { Atomics: {} }, { navigator: { hardwareConcurrency: 3 } }, { navigator: {} }]) {
      expect(supportsKokoroCpuPool({ ...capabilities, ...changed })).toBe(false);
    }
  });
  it('selects one coordinator and exactly three siblings, closing every owned handle on disposal', async () => {
    const { tts, workers, helpers } = await client();
    expect(tts.modelInfo.serial).toBe(false); expect(workers).toHaveLength(1); expect(helpers).toHaveLength(3);
    await tts.dispose(); expect(workers[0].terminate).toHaveBeenCalledOnce();
    for (const helper of helpers) expect(helper.terminate).toHaveBeenCalledOnce();
  });
  it('does not start helpers when actual capabilities require the existing serial engine', async () => {
    const { tts, workers, helpers } = await client({ scope: { ...capabilities, crossOriginIsolated: false } });
    expect(tts.modelInfo.serial).toBe(true); expect(helpers).toHaveLength(0); expect(workers[0].init.cpuParallel).toBe(false);
  });
  it('retries failed optional startup once in a fresh serial coordinator', async () => {
    const { tts, workers, helpers, requests } = await client({ startupFailure: true });
    expect(tts.modelInfo.serial).toBe(true); expect(workers).toHaveLength(2); expect(helpers).toHaveLength(0);
    expect(workers[0].terminate).toHaveBeenCalledOnce(); expect(requests.filter(value => value.method === 'init').map(value => value.cpuParallel)).toEqual([true, false]);
    await tts.generate('One request.'); expect(requests.filter(value => value.method === 'generate')).toHaveLength(1);
  });
  it('retires active and queued speech on a helper crash without replay, then opens serially', async () => {
    const { tts, workers, helpers, requests } = await client({ pendingGeneration: true });
    const active = tts.generate('active'), queued = tts.generate('queued');
    const failed = Promise.all([expect(active).rejects.toMatchObject({ code: 'kokoro_cpu_pool_failed' }), expect(queued).rejects.toMatchObject({ code: 'kokoro_cpu_pool_failed' })]);
    await vi.waitFor(() => expect(requests.filter(value => value.method === 'generate')).toHaveLength(2));
    helpers[1].onerror({ message: 'helper crashed' }); await failed;
    for (const helper of helpers) expect(helper.terminate).toHaveBeenCalledOnce(); expect(workers[0].terminate).toHaveBeenCalledOnce();
    await tts.prepareVoice('af_heart'); expect(workers).toHaveLength(2); expect(workers[1].init.cpuParallel).toBe(false);
    expect(requests.filter(value => value.method === 'generate').map(value => value.text)).toEqual(['active', 'queued']);
  });
  it('hard-aborts all four workers and rejects queued work while retaining capability selection on an intentional reopen', async () => {
    const { tts, workers, helpers, requests } = await client({ pendingGeneration: true });
    const controller = new AbortController(), active = tts.generate('active', { signal: controller.signal }), queued = tts.generate('queued');
    const failed = Promise.all([expect(active).rejects.toMatchObject({ name: 'AbortError' }), expect(queued).rejects.toMatchObject({ name: 'AbortError' })]);
    await vi.waitFor(() => expect(requests.filter(value => value.method === 'generate')).toHaveLength(2));
    controller.abort(); await failed;
    expect(workers[0].terminate).toHaveBeenCalledOnce(); for (const helper of helpers) expect(helper.terminate).toHaveBeenCalledOnce();
    await tts.prepareVoice('af_heart'); expect(workers).toHaveLength(2); expect(helpers).toHaveLength(6); expect(workers[1].init.cpuParallel).toBe(true);
  });
  it('ignores delayed old-generation responses after abort and never lets them resolve new RPCs', async () => {
    const { tts, workers } = await client();
    tts.abortGeneration(); await tts.prepareVoice('af_heart');
    workers[0].onmessage({ data: { cpuPool: { type: 'failed', generation: workers[0].init.cpuGeneration } } });
    expect(workers[1].terminate).not.toHaveBeenCalled(); await tts.prepareVoice('af_heart');
  });
  it('cancels every waiter during lazy startup without retrying serially after a user abort', async () => {
    const { tts, workers, helpers } = await client({ stallReopen: true }); tts.abortGeneration();
    const controller = new AbortController(), opening = tts.generate('opening', { signal: controller.signal }), queued = tts.prepareVoice('af_heart');
    const failed = Promise.all([expect(opening).rejects.toMatchObject({ name: 'AbortError' }), expect(queued).rejects.toMatchObject({ name: 'AbortError' })]);
    await vi.waitFor(() => expect(helpers).toHaveLength(6)); controller.abort(); await failed;
    expect(workers).toHaveLength(2); for (const worker of workers) expect(worker.terminate).toHaveBeenCalledOnce();
    for (const helper of helpers) expect(helper.terminate).toHaveBeenCalledOnce();
  });
});

describe('parallel row protocol guards', () => {
  it('partitions complete aligned pairs and permits only the final odd row', () => {
    const p = Uint32Array.of(1, 8, 79, 19, 77, 8, 19, 3, 1, 1, 1, 0, 1, 1, 19, 32);
    expect(kokoroCpuRowRanges(p, true)).toEqual([[0, 4], [4, 8], [8, 12], [12, 19]]);
    for (const [index, value] of [[0, 2], [1, 16], [5, 1], [3, 7], [15, 33], [14, 5], [11, 2]]) {
      const changed = new Uint32Array(p); changed[index] = value; expect(kokoroCpuRowRanges(changed, true)).toBeNull();
    }
  });
  it('retains serial execution for short or small work and bounds private stacks/params before tensor allocation', () => {
    const p = Uint32Array.of(1, 8, 79, 19, 31, 8, 19, 3, 1, 1, 1, 0, 1, 1, 19, 32);
    expect(kokoroCpuRowRanges(p)).toBeNull(); expect(kokoroCpuRowRanges(p, true)).not.toBeNull();
    const layout = kokoroCpuPoolLayout(70001);
    expect(layout.first % 16).toBe(0); expect(layout.control).toBeGreaterThanOrEqual(layout.stacks[3]);
    expect(layout.parameters.every((offset, i) => offset >= layout.control + 256 && (i === 0 || offset - layout.parameters[i - 1] === 8192))).toBe(true);
    expect(() => kokoroCpuPoolLayout(536870912)).toThrow('limit');
  });
  it('rejects duplicate starts and wrong module imports and terminates every helper already created', () => {
    vi.spyOn(WebAssembly.Module, 'imports').mockReturnValue(imports);
    const coordinator = { postMessage: vi.fn() }, helpers = [], fail = vi.fn();
    const owner = createKokoroCpuPoolOwner({ generation: 'g', coordinator, fail, createHelper: () => {
      const helper = { postMessage: vi.fn(), terminate: vi.fn() }; helpers.push(helper); return helper;
    } });
    fixtures.push({ dispose: owner.dispose }); owner.receive(boot('g')); owner.receive(boot('g'));
    expect(fail).toHaveBeenCalledOnce(); for (const helper of helpers) expect(helper.terminate).toHaveBeenCalledOnce();
    const otherFail = vi.fn(), other = createKokoroCpuPoolOwner({ generation: 'h', coordinator, fail: otherFail, createHelper: vi.fn() });
    fixtures.push({ dispose: other.dispose }); WebAssembly.Module.imports.mockReturnValue([{ module: 'env', name: 'run', kind: 'function' }]); other.receive(boot('h'));
    expect(otherFail).toHaveBeenCalledOnce();
  });
});
