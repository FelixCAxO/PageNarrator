// Source injected into the toolbar-player page before any product script runs.
// It applies a profile's reported-capability overrides and fault injections and
// records evidence the harness reads back: which injections actually fired and
// when the page's media elements produced non-silent audio.

export const PROBE_HARNESS_ADAPTER_OPTION = '__pnProbeHarness';

/**
 * @param {any} profile
 * @param {{ audioTap?: boolean }} [options]
 */
export function createProbePageHooksSource(profile = {}, { audioTap = true } = {}) {
  const config = {
    navigator: profile.navigator || {},
    hideWebGpu: Boolean(profile.disableWebGpu),
    gpuMode: profile.gpu?.mode || 'host',
    gpuProfile: profile.gpu || {},
    faults: (profile.faults || []).map((fault) => ({ ...fault })),
    audioTap,
    harnessOption: PROBE_HARNESS_ADAPTER_OPTION,
  };
  return `(${installProbePageHooks.toString()})(${JSON.stringify(config)});`;
}

// Runs inside the page; it must stay self-contained (no closures over module scope).
function installProbePageHooks(config) {
  const faults = new Map(config.faults.map((fault) => [fault.kind, fault]));
  const state = {
    counts: {},
    requestAdapterCalls: 0,
    requestDeviceCalls: 0,
    deviceLimits: null,
    devicesDestroyed: 0,
    errors: [],
  };
  globalThis.__pnProbeFaults = state;
  const count = (kind) => {
    state.counts[kind] = (state.counts[kind] || 0) + 1;
  };
  const defineNavigatorValue = (name, value) => {
    for (const target of [Navigator.prototype, navigator]) {
      try {
        Object.defineProperty(target, name, { configurable: true, get() { return value; } });
      } catch (error) {
        state.errors.push(`define ${name}: ${error?.message || error}`);
      }
    }
  };
  for (const [name, value] of Object.entries(config.navigator)) {
    if (value !== undefined && value !== null) defineNavigatorValue(name, value);
  }

  if (config.hideWebGpu) {
    defineNavigatorValue('gpu', undefined);
  } else if (config.gpuMode === 'no-adapter') {
    defineNavigatorValue('gpu', { requestAdapter: async () => null });
  } else if (config.gpuMode === 'simulated-adapter') {
    defineNavigatorValue('gpu', createFakeGpu(config.gpuProfile));
  } else if (navigator.gpu) {
    installGpuFaults();
  }

  installMainThreadObserver();
  installTranscriptRecorder();
  installNarrationRecorder();
  if (config.audioTap) installAudioTap();

  // What was queued for speech: the engine's state broadcasts carry every
  // queued chunk's speech text. The transcript card is a separate UI surface.
  function installNarrationRecorder() {
    const narration = {
      method: 'chrome.runtime.sendMessage reader-state broadcasts (speech text per queued chunk)',
      chunks: [],
      broadcasts: 0,
      errors: [],
    };
    globalThis.__pnProbeNarration = narration;
    const runtime = globalThis.chrome?.runtime;
    if (!runtime || typeof runtime.sendMessage !== 'function') {
      narration.errors.push('chrome.runtime.sendMessage unavailable');
      return;
    }
    const original = runtime.sendMessage;
    try {
      runtime.sendMessage = function sendMessage(message, ...rest) {
        try {
          const queue = Array.isArray(message?.queue) ? message.queue : null;
          if (queue) {
            narration.broadcasts += 1;
            for (let index = 0; index < queue.length; index += 1) {
              // Keep the fullest text; completed PDF chunks may later be compacted.
              const text = String(queue[index] || '');
              if (text.length > (narration.chunks[index]?.length || 0)) narration.chunks[index] = text;
            }
          }
        } catch (error) {
          if (narration.errors.length < 5) narration.errors.push(`record: ${error?.message || error}`);
        }
        return original.call(runtime, message, ...rest);
      };
    } catch (error) {
      narration.errors.push(`wrap sendMessage: ${error?.message || error}`);
    }
  }

  // The engine clears its transcript when a read ends, so content scoring uses
  // the fullest transcript rendered during the read.
  function installTranscriptRecorder() {
    const transcript = {
      method: 'MutationObserver on #transcript-text (fullest transcript rendered)',
      title: '',
      paragraphs: [],
      countLabel: '',
      textLength: 0,
      updates: 0,
    };
    globalThis.__pnProbeTranscript = transcript;
    if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return;
    // The page's initial text is the same placeholder the engine renders on reset.
    let placeholder = '';
    const capture = () => {
      const container = document.getElementById('transcript-text');
      if (!container) return;
      const paragraphs = [...container.querySelectorAll('p')].map((node) => node.textContent || '');
      if (placeholder && paragraphs.join('').trim() === placeholder) return;
      const textLength = paragraphs.reduce((total, text) => total + text.length, 0);
      if (textLength <= transcript.textLength) return;
      transcript.title = document.getElementById('article-title')?.textContent || '';
      transcript.paragraphs = paragraphs;
      transcript.countLabel = document.getElementById('transcript-count')?.textContent || '';
      transcript.textLength = textLength;
      transcript.updates += 1;
    };
    const start = () => {
      const container = document.getElementById('transcript-text');
      if (!container) return;
      placeholder = String(container.textContent || '').trim();
      new MutationObserver(capture).observe(container, { childList: true, subtree: true, characterData: true });
      capture();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }

  function createFakeGpu(gpuProfile) {
    const limits = gpuProfile?.limits || {};
    const adapterInfo = {
      vendor: gpuProfile?.vendor || '',
      architecture: gpuProfile?.architecture || '',
      device: gpuProfile?.device || '',
      description: gpuProfile?.description || '',
    };
    globalThis.GPUBufferUsage ||= { STORAGE: 128, COPY_SRC: 4, COPY_DST: 8, MAP_READ: 1 };
    globalThis.GPUMapMode ||= { READ: 1 };
    const buffer = {
      destroy() { return undefined; },
      mapAsync: async () => undefined,
      unmap() { return undefined; },
    };
    const device = {
      createBuffer: () => buffer,
      createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createBindGroup: () => ({}),
      createShaderModule: () => ({}),
      createCommandEncoder: () => ({
        beginComputePass: () => ({
          setPipeline() { return undefined; },
          setBindGroup() { return undefined; },
          dispatchWorkgroups() { return undefined; },
          end() { return undefined; },
        }),
        copyBufferToBuffer() { return undefined; },
        finish: () => ({}),
      }),
      queue: {
        writeBuffer() { return undefined; },
        submit() { return undefined; },
        onSubmittedWorkDone: async () => undefined,
      },
      destroy() { return undefined; },
    };
    return {
      requestAdapter: async () => ({
        info: adapterInfo,
        limits: {
          maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize ?? null,
          maxBufferSize: limits.maxBufferSize ?? null,
        },
        features: { has: () => false },
        requestAdapterInfo: async () => adapterInfo,
        requestDevice: async () => device,
      }),
    };
  }

  function installGpuFaults() {
    const gpu = navigator.gpu;
    const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
    const devices = [];
    const defaultLimits = { maxBufferSize: 268435456, maxStorageBufferBindingSize: 134217728 };
    Object.defineProperty(gpu, 'requestAdapter', {
      configurable: true,
      value: async (options) => {
        const harness = Boolean(options && options[config.harnessOption]);
        let cleanOptions = options;
        if (harness) {
          cleanOptions = { ...options };
          delete cleanOptions[config.harnessOption];
          if (!Object.keys(cleanOptions).length) cleanOptions = undefined;
        } else {
          state.requestAdapterCalls += 1;
        }
        if (faults.has('webgpu-request-adapter-rejects')) {
          if (!harness) count('webgpu-request-adapter-rejects');
          throw new DOMException('Injected requestAdapter() failure', 'OperationError');
        }
        return originalRequestAdapter(cleanOptions);
      },
    });

    const adapterPrototype = globalThis.GPUAdapter?.prototype;
    if (adapterPrototype) {
      if (faults.has('webgpu-default-limits')) {
        const limitsDescriptor = Object.getOwnPropertyDescriptor(adapterPrototype, 'limits');
        Object.defineProperty(adapterPrototype, 'limits', {
          configurable: true,
          get() {
            const real = limitsDescriptor.get.call(this);
            const copy = {};
            for (const key in real) copy[key] = real[key];
            return Object.freeze({ ...copy, ...defaultLimits });
          },
        });
      }
      const originalRequestDevice = adapterPrototype.requestDevice;
      adapterPrototype.requestDevice = async function requestDevice(descriptor) {
        state.requestDeviceCalls += 1;
        if (faults.has('webgpu-request-device-rejects')) {
          count('webgpu-request-device-rejects');
          throw new DOMException('Injected requestDevice() failure', 'OperationError');
        }
        let nextDescriptor = descriptor;
        if (faults.has('webgpu-default-limits') && descriptor?.requiredLimits) {
          const requiredLimits = { ...descriptor.requiredLimits };
          for (const key of Object.keys(defaultLimits)) delete requiredLimits[key];
          nextDescriptor = { ...descriptor, requiredLimits };
        }
        const device = await originalRequestDevice.call(this, nextDescriptor);
        devices.push(device);
        state.deviceLimits = {
          maxBufferSize: device.limits.maxBufferSize,
          maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
        };
        if (faults.has('webgpu-default-limits')
          && device.limits.maxBufferSize <= defaultLimits.maxBufferSize
          && device.limits.maxStorageBufferBindingSize <= defaultLimits.maxStorageBufferBindingSize) {
          count('webgpu-default-limits');
        }
        return device;
      };
    }

    if (faults.has('webgpu-readback-latency') && globalThis.GPUBuffer?.prototype?.mapAsync) {
      const delayMs = Number(faults.get('webgpu-readback-latency').delayMs) || 0;
      const originalMapAsync = GPUBuffer.prototype.mapAsync;
      GPUBuffer.prototype.mapAsync = function mapAsync(...args) {
        return originalMapAsync.apply(this, args).then((value) => new Promise((resolve) => {
          setTimeout(() => {
            count('webgpu-readback-latency');
            resolve(value);
          }, delayMs);
        }));
      };
    }

    state.destroyDevices = () => {
      let destroyed = 0;
      for (const device of devices) {
        try {
          device.destroy();
          destroyed += 1;
        } catch (error) {
          state.errors.push(`destroy: ${error?.message || error}`);
        }
      }
      state.devicesDestroyed += destroyed;
      if (destroyed && faults.has('webgpu-device-destroyed')) count('webgpu-device-destroyed');
      return destroyed;
    };
  }

  // Long tasks block controls, media events and the audio tap's own polling.
  function installMainThreadObserver() {
    const MAX_ENTRIES = 200;
    const mainThread = {
      method: 'PerformanceObserver longtask entries (toolbar-player page main thread)',
      supported: false,
      longTasks: 0,
      totalLongTaskMs: 0,
      totalBlockingMs: 0,
      maxLongTaskMs: 0,
      entries: [],
      errors: [],
    };
    globalThis.__pnProbeMainThread = mainThread;
    try {
      if (typeof PerformanceObserver !== 'function' || !PerformanceObserver.supportedEntryTypes?.includes('longtask')) return;
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          mainThread.longTasks += 1;
          mainThread.totalLongTaskMs += entry.duration;
          mainThread.totalBlockingMs += Math.max(0, entry.duration - 50);
          mainThread.maxLongTaskMs = Math.max(mainThread.maxLongTaskMs, entry.duration);
          mainThread.entries.push({ startEpochMs: performance.timeOrigin + entry.startTime, durationMs: entry.duration });
          if (mainThread.entries.length > MAX_ENTRIES) mainThread.entries.shift();
        }
      });
      observer.observe({ type: 'longtask', buffered: true });
      mainThread.supported = true;
    } catch (error) {
      mainThread.errors.push(`longtask observer: ${error?.message || error}`);
    }
  }

  function installAudioTap() {
    const SILENCE_PEAK = 0.001;
    const POLL_MS = 10;
    const FFT_SIZE = 1024;
    const audio = {
      method: 'HTMLMediaElement.captureStream() -> AnalyserNode (page media output, not OS loopback)',
      pollMs: POLL_MS,
      windowSamples: FFT_SIZE,
      sampleRate: null,
      tappedElements: 0,
      firstNonSilentEpochMs: null,
      lastNonSilentEpochMs: null,
      nonSilentMs: 0,
      playingSilentMs: 0,
      longestPlayingSilenceMs: 0,
      segments: [],
      playEvents: 0,
      // Media events that mean the element is not advancing on its own.
      mediaEvents: { waiting: 0, stalled: 0, error: 0 },
      // Longest interval between polls; a blocked main thread delays them.
      maxTickGapMs: 0,
      maxTickGapEndEpochMs: null,
      // Latest tick: whether any element was playing and whether it was audible.
      playingNow: false,
      audibleNow: false,
      lastTickEpochMs: null,
      errors: [],
    };
    globalThis.__pnProbeAudio = audio;
    const taps = [];
    // Read on demand so a stalled element can be told apart from a silent one.
    globalThis.__pnProbeAudioState = () => ({
      contextState: context?.state || null,
      contextTimeSeconds: context ? context.currentTime : null,
      elements: taps.map(({ element }) => ({
        srcKind: String(element.currentSrc || element.src || '').split(':')[0] || null,
        currentTimeSeconds: element.currentTime,
        durationSeconds: Number.isFinite(element.duration) ? element.duration : null,
        readyState: element.readyState,
        networkState: element.networkState,
        paused: element.paused,
        ended: element.ended,
        errorCode: element.error?.code ?? null,
      })),
    });
    let context = null;
    let currentSilenceStart = null;
    let segmentStart = null;
    let lastTick = null;

    const ensureContext = () => {
      if (!context) {
        context = new AudioContext();
        audio.sampleRate = context.sampleRate;
      }
      if (context.state === 'suspended') context.resume().catch((error) => audio.errors.push(`resume: ${error?.message || error}`));
      return context;
    };

    const connect = (tap) => {
      const stream = tap.element.captureStream?.();
      const track = stream?.getAudioTracks?.()[0];
      if (!track || track.id === tap.trackId) return;
      tap.source?.disconnect();
      const ctx = ensureContext();
      tap.source = ctx.createMediaStreamSource(new MediaStream([track]));
      tap.analyser = ctx.createAnalyser();
      tap.analyser.fftSize = FFT_SIZE;
      tap.buffer = new Float32Array(FFT_SIZE);
      tap.source.connect(tap.analyser);
      tap.trackId = track.id;
    };

    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function play(...args) {
      audio.playEvents += 1;
      try {
        let tap = taps.find((entry) => entry.element === this);
        if (!tap) {
          tap = { element: this, trackId: null, source: null, analyser: null, buffer: null };
          taps.push(tap);
          audio.tappedElements += 1;
          const reconnect = () => {
            try {
              connect(tap);
            } catch (error) {
              audio.errors.push(`connect: ${error?.message || error}`);
            }
          };
          this.addEventListener('playing', reconnect);
          this.addEventListener('loadeddata', reconnect);
          for (const type of Object.keys(audio.mediaEvents)) {
            this.addEventListener(type, () => {
              audio.mediaEvents[type] += 1;
            });
          }
        }
        queueMicrotask(() => {
          try {
            connect(tap);
          } catch (error) {
            audio.errors.push(`connect: ${error?.message || error}`);
          }
        });
      } catch (error) {
        audio.errors.push(`play hook: ${error?.message || error}`);
      }
      return originalPlay.apply(this, args);
    };

    setInterval(() => {
      const now = performance.timeOrigin + performance.now();
      const elapsed = lastTick === null ? 0 : now - lastTick;
      lastTick = now;
      if (elapsed > audio.maxTickGapMs) {
        audio.maxTickGapMs = elapsed;
        audio.maxTickGapEndEpochMs = now;
      }
      let playing = false;
      let audible = false;
      for (const tap of taps) {
        const element = tap.element;
        if (element.paused || element.ended) continue;
        playing = true;
        if (!tap.analyser) continue;
        tap.analyser.getFloatTimeDomainData(tap.buffer);
        let peak = 0;
        for (let index = 0; index < tap.buffer.length; index += 1) {
          const value = Math.abs(tap.buffer[index]);
          if (value > peak) peak = value;
        }
        if (peak > SILENCE_PEAK) audible = true;
      }
      audio.playingNow = playing;
      audio.audibleNow = audible;
      audio.lastTickEpochMs = now;
      if (audible) {
        audio.firstNonSilentEpochMs ??= now;
        audio.lastNonSilentEpochMs = now;
        audio.nonSilentMs += elapsed;
        if (segmentStart === null) segmentStart = now;
        currentSilenceStart = null;
      } else {
        if (segmentStart !== null) {
          audio.segments.push({ startEpochMs: segmentStart, endEpochMs: now });
          if (audio.segments.length > 2000) audio.segments.shift();
          segmentStart = null;
        }
        if (playing) {
          audio.playingSilentMs += elapsed;
          currentSilenceStart ??= now;
          audio.longestPlayingSilenceMs = Math.max(audio.longestPlayingSilenceMs, now - currentSilenceStart);
        } else {
          currentSilenceStart = null;
        }
      }
    }, POLL_MS);
  }
}
