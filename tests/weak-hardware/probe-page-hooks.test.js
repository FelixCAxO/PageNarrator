import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { PROBE_HARNESS_ADAPTER_OPTION, createProbePageHooksSource } from '../live/tts-probe-page-hooks.js';

// A minimal page-like global with WebGPU and media prototypes the hooks patch.
function createPage({ adapterLimits = { maxBufferSize: 2 ** 31, maxStorageBufferBindingSize: 2 ** 31 - 4, maxComputeWorkgroupSizeX: 256 } } = {}) {
  const intervals = [];
  class Navigator {}
  class GPUAdapter {
    get limits() {
      return { ...adapterLimits };
    }

    async requestDevice(descriptor = {}) {
      const required = descriptor.requiredLimits || {};
      const device = {
        descriptor,
        destroyed: false,
        limits: {
          maxBufferSize: required.maxBufferSize ?? 268435456,
          maxStorageBufferBindingSize: required.maxStorageBufferBindingSize ?? 134217728,
        },
        destroy() {
          this.destroyed = true;
        },
      };
      page.devices.push(device);
      return device;
    }
  }
  class GPUBuffer {
    async mapAsync() {
      return 'mapped';
    }
  }
  class HTMLMediaElement {
    play() {
      return Promise.resolve();
    }
  }
  const navigator = new Navigator();
  navigator.gpu = { requestAdapter: async () => new GPUAdapter() };
  const page = {
    devices: [],
    intervals,
    Navigator,
    navigator,
    GPUAdapter,
    GPUBuffer,
    HTMLMediaElement,
    DOMException: class extends Error {
      constructor(message, name) {
        super(message);
        this.name = name;
      }
    },
    setTimeout,
    setInterval: (callback) => intervals.push(callback),
    queueMicrotask,
    performance: { timeOrigin: 1_000, now: () => 0 },
  };
  page.globalThis = page;
  return page;
}

function install(page, profile, options = { audioTap: false }) {
  vm.runInNewContext(createProbePageHooksSource(profile, options), page);
  return page;
}

describe('probe page hooks', () => {
  it('applies reported navigator overrides and can hide WebGPU', () => {
    const page = install(createPage(), { navigator: { hardwareConcurrency: 2, deviceMemory: 4 }, disableWebGpu: true });

    expect(page.navigator.hardwareConcurrency).toBe(2);
    expect(page.navigator.deviceMemory).toBe(4);
    expect(page.navigator.gpu).toBeUndefined();
  });

  it('counts product requestAdapter() failures but not harness observations', async () => {
    const page = install(createPage(), { faults: [{ kind: 'webgpu-request-adapter-rejects' }] });

    await expect(page.navigator.gpu.requestAdapter({ [PROBE_HARNESS_ADAPTER_OPTION]: true })).rejects.toThrow(/Injected requestAdapter/);
    expect(page.__pnProbeFaults.counts).toEqual({});
    await expect(page.navigator.gpu.requestAdapter()).rejects.toThrow(/Injected requestAdapter/);
    expect(page.__pnProbeFaults.counts).toEqual({ 'webgpu-request-adapter-rejects': 1 });
    expect(page.__pnProbeFaults.requestAdapterCalls).toBe(1);
  });

  it('rejects requestDevice() on a real adapter and counts each attempt', async () => {
    const page = install(createPage(), { faults: [{ kind: 'webgpu-request-device-rejects' }] });
    const adapter = await page.navigator.gpu.requestAdapter();

    await expect(adapter.requestDevice({})).rejects.toThrow(/Injected requestDevice/);
    expect(page.__pnProbeFaults).toMatchObject({ requestDeviceCalls: 1, counts: { 'webgpu-request-device-rejects': 1 } });
  });

  it('reports default adapter limits and creates the real device with them', async () => {
    const page = install(createPage(), { faults: [{ kind: 'webgpu-default-limits' }] });
    const adapter = await page.navigator.gpu.requestAdapter();

    expect(adapter.limits).toMatchObject({ maxBufferSize: 268435456, maxStorageBufferBindingSize: 134217728, maxComputeWorkgroupSizeX: 256 });
    const device = await adapter.requestDevice({ requiredLimits: { maxBufferSize: 2 ** 31, maxComputeWorkgroupSizeX: 256 } });

    expect(device.descriptor.requiredLimits).toEqual({ maxComputeWorkgroupSizeX: 256 });
    expect(page.__pnProbeFaults.deviceLimits).toEqual({ maxBufferSize: 268435456, maxStorageBufferBindingSize: 134217728 });
    expect(page.__pnProbeFaults.counts['webgpu-default-limits']).toBe(1);
  });

  it('destroys captured devices on request to simulate device loss', async () => {
    const page = install(createPage(), { faults: [{ kind: 'webgpu-device-destroyed' }] });
    const adapter = await page.navigator.gpu.requestAdapter();
    await adapter.requestDevice({});

    expect(page.__pnProbeFaults.destroyDevices()).toBe(1);
    expect(page.devices[0].destroyed).toBe(true);
    expect(page.__pnProbeFaults.counts['webgpu-device-destroyed']).toBe(1);
  });

  it('delays GPU readback for synthetic latency injection', async () => {
    const page = install(createPage(), { faults: [{ kind: 'webgpu-readback-latency', delayMs: 20 }] });
    const started = Date.now();

    await expect(new page.GPUBuffer().mapAsync(1)).resolves.toBe('mapped');
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    expect(page.__pnProbeFaults.counts['webgpu-readback-latency']).toBe(1);
  });

  it('leaves the host GPU path unchanged when no fault is declared', async () => {
    const page = install(createPage(), {});
    const adapter = await page.navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice({ requiredLimits: { maxBufferSize: 2 ** 31 } });

    expect(device.limits.maxBufferSize).toBe(2 ** 31);
    expect(page.__pnProbeFaults.counts).toEqual({});
    expect(page.__pnProbeFaults.requestDeviceCalls).toBe(1);
  });

  it('timestamps the first non-silent media output from the audio tap', async () => {
    const page = createPage();
    let clock = 0;
    page.performance = { timeOrigin: 1_000_000, now: () => clock };
    page.MediaStream = class {
      constructor(tracks) {
        this.tracks = tracks;
      }
    };
    let level = 0;
    page.AudioContext = class {
      constructor() {
        this.sampleRate = 48_000;
        this.state = 'running';
      }

      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }

      createAnalyser() {
        return {
          fftSize: 0,
          getFloatTimeDomainData(buffer) {
            buffer.fill(level);
          },
        };
      }
    };
    install(page, {}, { audioTap: true });
    const element = new page.HTMLMediaElement();
    element.paused = false;
    element.ended = false;
    element.addEventListener = () => {};
    element.captureStream = () => ({ getAudioTracks: () => [{ id: 'track-1' }] });

    await element.play();
    await Promise.resolve();
    const tick = page.intervals[0];
    clock = 10;
    tick();
    level = 0.2;
    clock = 20;
    tick();
    clock = 30;
    tick();

    expect(page.__pnProbeAudio).toMatchObject({
      tappedElements: 1,
      firstNonSilentEpochMs: 1_000_020,
      lastNonSilentEpochMs: 1_000_030,
      sampleRate: 48_000,
    });
    expect(page.__pnProbeAudio.nonSilentMs).toBe(20);
  });

  it('records poll gaps, stall events and element state from the audio tap', async () => {
    const page = createPage();
    let clock = 0;
    page.performance = { timeOrigin: 0, now: () => clock };
    page.MediaStream = class {};
    page.AudioContext = class {
      constructor() {
        this.sampleRate = 48_000;
        this.state = 'running';
        this.currentTime = 4;
      }

      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }

      createAnalyser() {
        return { getFloatTimeDomainData(buffer) { buffer.fill(0); } };
      }
    };
    install(page, {}, { audioTap: true });
    const listeners = {};
    const element = new page.HTMLMediaElement();
    Object.assign(element, { paused: false, ended: false, src: 'blob:chrome-extension://x/1', currentTime: 0.2, duration: 3.075, readyState: 2, networkState: 1, error: null });
    element.addEventListener = (type, handler) => {
      (listeners[type] ||= []).push(handler);
    };
    element.captureStream = () => ({ getAudioTracks: () => [{ id: 'track-1' }] });

    await element.play();
    await Promise.resolve();
    listeners.waiting.forEach((handler) => handler());
    listeners.stalled.forEach((handler) => handler());
    const tick = page.intervals[0];
    tick();
    clock = 10;
    tick();
    clock = 2_510;
    tick();

    expect(page.__pnProbeAudio.maxTickGapMs).toBe(2_500);
    expect(page.__pnProbeAudio.maxTickGapEndEpochMs).toBe(2_510);
    expect(page.__pnProbeAudio.mediaEvents).toEqual({ waiting: 1, stalled: 1, error: 0 });
    expect(page.__pnProbeAudioState()).toEqual({
      contextState: 'running',
      contextTimeSeconds: 4,
      elements: [{ srcKind: 'blob', currentTimeSeconds: 0.2, durationSeconds: 3.075, readyState: 2, networkState: 1, paused: false, ended: false, errorCode: null }],
    });
  });

  it('records main-thread long tasks when the page supports them', () => {
    const page = createPage();
    let deliver = null;
    page.performance = { timeOrigin: 1_000, now: () => 0 };
    page.PerformanceObserver = class {
      static supportedEntryTypes = ['longtask'];

      constructor(callback) {
        deliver = (entries) => callback({ getEntries: () => entries });
      }

      observe(options) {
        this.options = options;
      }
    };
    install(page, {});
    deliver([{ startTime: 100, duration: 2_400 }, { startTime: 3_000, duration: 60 }]);

    expect(page.__pnProbeMainThread).toMatchObject({
      supported: true,
      longTasks: 2,
      totalLongTaskMs: 2_460,
      totalBlockingMs: 2_360,
      maxLongTaskMs: 2_400,
      entries: [{ startEpochMs: 1_100, durationMs: 2_400 }, { startEpochMs: 4_000, durationMs: 60 }],
    });
  });

  it('keeps the fullest transcript rendered during a read after the engine clears it', () => {
    const page = createPage();
    const placeholder = 'Transcript appears when text loads.';
    const nodes = { 'transcript-text': { paragraphs: [] }, 'article-title': { textContent: 'No page loaded' }, 'transcript-count': { textContent: '0 paragraphs' } };
    let notify = null;
    page.document = {
      readyState: 'complete',
      getElementById: (id) => (id === 'transcript-text'
        ? {
          textContent: nodes[id].paragraphs.length ? nodes[id].paragraphs.join('') : placeholder,
          querySelectorAll: () => nodes[id].paragraphs.map((textContent) => ({ textContent })),
        }
        : nodes[id]),
    };
    page.MutationObserver = class {
      constructor(callback) {
        notify = callback;
      }

      observe() {}
    };
    install(page, {});
    const render = (title, paragraphs, label) => {
      Object.assign(nodes, { 'article-title': { textContent: title }, 'transcript-count': { textContent: label } });
      nodes['transcript-text'].paragraphs = paragraphs;
      notify();
    };

    render('Probe', ['First section.'], '1 paragraph');
    render('Probe', ['First section. Second section.'], '1 paragraph');
    render('No page loaded', [placeholder], '1 paragraph');
    render('No page loaded', [], '0 paragraphs');

    expect(page.__pnProbeTranscript).toMatchObject({ title: 'Probe', paragraphs: ['First section. Second section.'], countLabel: '1 paragraph', updates: 2 });
  });

  it('records queued speech text from reader-state broadcasts without changing delivery', async () => {
    const page = createPage();
    const sent = [];
    const runtime = {
      sendMessage(message) {
        sent.push({ message, receiver: this });
        return Promise.resolve('delivered');
      },
    };
    page.chrome = { runtime };
    install(page, {});
    const send = runtime.sendMessage;

    await expect(runtime.sendMessage({ type: 'reader-state', queue: ['First chunk.', 'Second chunk.'] })).resolves.toBe('delivered');
    // Detached call, and a later broadcast where a completed chunk was compacted.
    await send({ type: 'reader-state', queue: ['First…', 'Second chunk.', 'Third chunk.'] });
    await runtime.sendMessage({ type: 'other' });

    expect(page.__pnProbeNarration).toMatchObject({ chunks: ['First chunk.', 'Second chunk.', 'Third chunk.'], broadcasts: 2, errors: [] });
    expect(sent).toHaveLength(3);
    expect(sent.every((entry) => entry.receiver === runtime)).toBe(true);
  });

  it('reports narration as unavailable outside an extension page', () => {
    const page = install(createPage(), {});

    expect(page.__pnProbeNarration).toMatchObject({ chunks: [], errors: ['chrome.runtime.sendMessage unavailable'] });
  });

  it('reports long tasks as unsupported instead of failing the page', () => {
    const page = install(createPage(), {});

    expect(page.__pnProbeMainThread).toMatchObject({ supported: false, longTasks: 0, errors: [] });
  });
});
