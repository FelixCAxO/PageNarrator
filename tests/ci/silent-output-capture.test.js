import { afterEach, expect, it, vi } from 'vitest';
import { installSilentOutputCapture } from '../e2e/silent-output-capture.js';

vi.mock('node:fs/promises', () => ({ writeFile: vi.fn(async () => {}) }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete globalThis.__silentOutputCapture; delete globalThis.__silentCaptureReady;
});

it('keeps the original route, requires a silent sink and preserves render-thread samples in the WAV', async () => {
  class Node {
    constructor(context) { this.context = context; this.connections = []; }
    connect(destination) { this.connections.push(destination); return destination; }
  }
  class Context {
    constructor(options) { this.sinkId = options.sinkId; this.sampleRate = 48000; this.currentTime = 0;
      this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
  }
  let recorder;
  class Recorder extends Node {
    constructor(context) { super(context); recorder = this;
      this.port = { postMessage: () => this.port.onmessage({ data: { flushed: true } }) }; }
  }
  vi.stubGlobal('location', { pathname: '/src/reader-engine.html' });
  vi.stubGlobal('chrome', { runtime: { getURL: x => x } });
  vi.stubGlobal('AudioContext', Context); vi.stubGlobal('AudioNode', Node); vi.stubGlobal('AudioWorkletNode', Recorder);
  await installSilentOutputCapture({ addInitScript: (fn, argument) => fn(argument) }, 'test-copy');
  await globalThis.__silentCaptureReady;
  const context = new globalThis.AudioContext(), source = new Node(context);
  expect(context.sinkId.type).toBe('none');
  expect(source.connect(context.destination)).toBe(context.destination);
  expect(source.connections).toEqual([context.destination, recorder]);
  const samples = Float32Array.of(0, .5, -.25, .125);
  recorder.port.onmessage({ data: { frame: 12000, pcm: samples } });
  const captured = await globalThis.__silentOutputCapture(), bytes = Uint8Array.from(Buffer.from(captured.base64, 'base64')), view = new DataView(bytes.buffer);
  expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF');
  expect(view.getUint16(20, true)).toBe(3); expect(view.getUint32(24, true)).toBe(48000);
  expect(view.getUint32(40, true)).toBe(16);
  expect(Array.from({ length: samples.length }, (_, i) => view.getFloat32(44 + i * 4, true))).toEqual([...samples]);
  expect(captured.metadata.captureWarnings).toEqual([]);
});

it('flushes a suspended capture after playback stops instead of waiting on a paused worklet', async () => {
  class Node {
    connect(destination) { return destination; }
  }
  class Context {
    constructor(options) {
      this.sinkId = options.sinkId; this.sampleRate = 48000; this.currentTime = 0;
      this.state = 'suspended'; this.destination = {}; this.audioWorklet = { addModule: async () => {} };
      this.resume = vi.fn(async () => { this.state = 'running'; });
    }
  }
  let recorder;
  class Recorder extends Node {
    constructor(context) {
      super(); recorder = this;
      this.port = { postMessage: () => {
        if (context.state === 'running') this.port.onmessage({ data: { flushed: true } });
      } };
    }
  }
  vi.stubGlobal('location', { pathname: '/src/reader-engine.html' });
  vi.stubGlobal('chrome', { runtime: { getURL: x => x } });
  vi.stubGlobal('AudioContext', Context); vi.stubGlobal('AudioNode', Node); vi.stubGlobal('AudioWorkletNode', Recorder);
  await installSilentOutputCapture({ addInitScript: (fn, argument) => fn(argument) }, 'test-copy');
  await globalThis.__silentCaptureReady;
  const context = new globalThis.AudioContext();
  recorder.port.onmessage({ data: { frame: 0, pcm: Float32Array.of(.5) } });
  const capture = globalThis.__silentOutputCapture();
  await Promise.resolve();
  expect(context.resume).toHaveBeenCalledOnce();
  const result = await capture;
  expect(result.metadata.captureWarnings).toEqual([]);
  expect(Buffer.from(result.base64, 'base64').readFloatLE(44)).toBe(.5);
});

it('fails promptly when the render thread never acknowledges its final flush', async () => {
  class Node { connect(destination) { return destination; } }
  class Context {
    constructor(options) {
      this.sinkId = options.sinkId; this.sampleRate = 48000; this.currentTime = 0;
      this.state = 'running'; this.destination = {}; this.audioWorklet = { addModule: async () => {} };
    }
  }
  class Recorder extends Node {
    constructor() { super(); this.port = { postMessage() {} }; }
  }
  vi.stubGlobal('location', { pathname: '/src/reader-engine.html' });
  vi.stubGlobal('chrome', { runtime: { getURL: x => x } });
  vi.stubGlobal('AudioContext', Context); vi.stubGlobal('AudioNode', Node); vi.stubGlobal('AudioWorkletNode', Recorder);
  await installSilentOutputCapture({ addInitScript: (fn, argument) => fn(argument) }, 'test-copy');
  await globalThis.__silentCaptureReady;
  vi.useFakeTimers();
  const failure = expect(globalThis.__silentOutputCapture()).rejects.toThrow('Silent capture final flush timed out.');
  await vi.advanceTimersByTimeAsync(5000);
  await failure;
});

it.each([
  ['empty', []],
  ['silent', [{ frame: 0, pcm: Float32Array.of(0, 0) }]],
  ['non-finite', [{ frame: 0, pcm: Float32Array.of(.5, NaN) }]],
  ['discontinuous', [{ frame: 0, pcm: Float32Array.of(.5) }, { frame: 2, pcm: Float32Array.of(.5) }]],
])('rejects %s render capture rather than producing qualifying evidence', async (_name, blocks) => {
  class Node { connect(destination) { return destination; } }
  class Context {
    constructor(options) {
      this.sinkId = options.sinkId; this.sampleRate = 48000; this.currentTime = 0;
      this.state = 'running'; this.destination = {}; this.audioWorklet = { addModule: async () => {} };
    }
  }
  let recorder;
  class Recorder extends Node {
    constructor() {
      super(); recorder = this;
      this.port = { postMessage: () => this.port.onmessage({ data: { flushed: true } }) };
    }
  }
  vi.stubGlobal('location', { pathname: '/src/reader-engine.html' });
  vi.stubGlobal('chrome', { runtime: { getURL: x => x } });
  vi.stubGlobal('AudioContext', Context); vi.stubGlobal('AudioNode', Node); vi.stubGlobal('AudioWorkletNode', Recorder);
  await installSilentOutputCapture({ addInitScript: (fn, argument) => fn(argument) }, 'test-copy');
  await globalThis.__silentCaptureReady;
  for (const block of blocks) recorder.port.onmessage({ data: block });
  await expect(globalThis.__silentOutputCapture()).rejects.toThrow('Silent capture');
});
