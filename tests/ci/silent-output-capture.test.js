import { afterEach, expect, it, vi } from 'vitest';
import { installSilentOutputCapture } from '../e2e/silent-output-capture.js';

vi.mock('node:fs/promises', () => ({ writeFile: vi.fn(async () => {}) }));
afterEach(() => {
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
  await installSilentOutputCapture({ addInitScript: fn => fn() }, 'test-copy');
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
