import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const worklet = `class Capture extends AudioWorkletProcessor {
  constructor() {
    super(); this.parts = []; this.frames = 0; this.start = 0;
    this.port.onmessage = ({data}) => { this.flush(); this.port.postMessage({flushed:data.flush}); };
  }
  flush() {
    if (!this.frames) return;
    const pcm = new Float32Array(this.frames); let offset = 0;
    for (const part of this.parts) { pcm.set(part, offset); offset += part.length; }
    this.port.postMessage({frame:this.start, pcm}, [pcm.buffer]); this.parts = []; this.frames = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0] || new Float32Array(128);
    if (!this.frames) this.start = currentFrame;
    this.parts.push(input.slice()); this.frames += input.length;
    if (this.frames >= sampleRate / 2) this.flush();
    return true;
  }
}
registerProcessor('pn-silent-capture', Capture);`;

/** Capture on the render thread into a non-rendering sink; physical output stays muted. */
export async function installSilentOutputCapture(context, extensionDir) {
  await writeFile(path.join(extensionDir, 'pn-silent-capture.js'), worklet);
  await context.addInitScript(() => {
    if (!location.pathname.endsWith('/reader-engine.html')) return;
    const Native = AudioContext, connect = AudioNode.prototype.connect;
    const audioContext = new Native({ latencyHint: 'interactive', sinkId: { type: 'none' } });
    if (audioContext.sinkId?.type !== 'none') throw new Error('Silent capture requires a non-rendering sink.');
    const epoch = Date.now() / 1000 - audioContext.currentTime;
    const chunks = [], warnings = [];
    let recorder, firstFrame = null, nextFrame = null, claimed = false, flushed = null;
    globalThis.AudioContext = new Proxy(Native, { construct(Target, args) {
      if (!claimed) { claimed = true; return audioContext; }
      return new Target({ ...args[0], sinkId: { type: 'none' } });
    } });
    AudioNode.prototype.connect = function (destination, ...args) {
      const result = connect.call(this, destination, ...args);
      if (destination === audioContext.destination && this !== recorder) {
        if (!recorder) throw new Error('Silent capture worklet is not ready.');
        connect.call(this, recorder);
      }
      return result;
    };
    globalThis.__silentCaptureReady = (async () => {
      await audioContext.audioWorklet.addModule(chrome.runtime.getURL('pn-silent-capture.js'));
      recorder = new AudioWorkletNode(audioContext, 'pn-silent-capture', { channelCount: 1, channelCountMode: 'explicit' });
      recorder.port.onmessage = ({ data }) => {
        if (data.pcm) {
          firstFrame ??= data.frame;
          if (nextFrame !== null && nextFrame !== data.frame) warnings.push(`Missing render frames at ${nextFrame}`);
          chunks.push(data.pcm); nextFrame = data.frame + data.pcm.length;
        } else if (data.flushed) { flushed?.(); flushed = null; }
      };
      connect.call(recorder, audioContext.destination);
    })();
    globalThis.__silentOutputCapture = async () => {
      await __silentCaptureReady;
      await new Promise(resolve => { flushed = resolve; recorder.port.postMessage({ flush: true }); });
      const samples = chunks.reduce((n, chunk) => n + chunk.length, 0), rate = audioContext.sampleRate;
      const bytes = new Uint8Array(44 + samples * 4), view = new DataView(bytes.buffer);
      const word = (at, value) => [...value].forEach((letter, i) => { bytes[at + i] = letter.charCodeAt(0); });
      word(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); word(8, 'WAVE'); word(12, 'fmt ');
      view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, 1, true);
      view.setUint32(24, rate, true); view.setUint32(28, rate * 4, true);
      view.setUint16(32, 4, true); view.setUint16(34, 32, true); word(36, 'data'); view.setUint32(40, samples * 4, true);
      let offset = 44;
      for (const chunk of chunks) for (const value of chunk) { view.setFloat32(offset, value, true); offset += 4; }
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      return { base64: btoa(binary), metadata: { startedEpochSeconds: epoch + firstFrame / rate,
        rate, channels: 1, captureWarnings: warnings,
        scope: 'Render-thread AudioWorklet capture with a non-rendering sink; browser physical output muted; excludes OS/device routing' } };
    };
  });
}
