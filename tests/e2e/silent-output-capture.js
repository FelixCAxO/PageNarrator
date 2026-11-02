import assert from 'node:assert/strict';
import { open, writeFile } from 'node:fs/promises';
import path from 'node:path';

const worklet = `class Capture extends AudioWorkletProcessor {
  constructor() {
    super(); this.parts = []; this.frames = 0; this.start = 0; this.stopped = false;
    this.port.onmessage = ({data}) => { this.flush(); this.stopped = Boolean(data.stop); this.port.postMessage({flushed:data.flush}); };
  }
  flush() {
    if (!this.frames) return;
    const pcm = new Float32Array(this.frames); let offset = 0;
    for (const part of this.parts) { pcm.set(part, offset); offset += part.length; }
    this.port.postMessage({frame:this.start, pcm}, [pcm.buffer]); this.parts = []; this.frames = 0;
  }
  process(inputs) {
    if (this.stopped) return true;
    const input = inputs[0]?.[0] || new Float32Array(128);
    if (!this.frames) this.start = currentFrame;
    this.parts.push(input.slice()); this.frames += input.length;
    if (this.frames >= sampleRate / 2) this.flush();
    return true;
  }
}
registerProcessor('pn-silent-capture', Capture);`;

/** Capture on the render thread into a non-rendering sink; physical output stays muted. */
export async function installSilentOutputCapture(context, extensionDir, { outputPath = null } = {}) {
  let file, closing, writtenBytes = 0;
  const close = () => closing ??= file?.close();
  if (outputPath) {
    file = await open(outputPath, 'wx'); await file.writeFile(Buffer.alloc(44));
    await context.exposeFunction('__pnWriteSilentCapture', async base64 => {
      assert(typeof base64 === 'string' && base64.length <= 1024 * 1024, 'Invalid capture block');
      const bytes = Buffer.from(base64, 'base64');
      assert(bytes.length && bytes.length % 4 === 0, 'Unaligned float32 capture block');
      for (let offset = 0; offset < bytes.length;) {
        const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
        assert(bytesWritten > 0); offset += bytesWritten;
      }
      writtenBytes += bytes.length;
    });
    context.once('close', () => { void close().catch(error => console.warn('Capture close failed', error)); });
  }
  await writeFile(path.join(extensionDir, 'pn-silent-capture.js'), worklet);
  await context.addInitScript(({ streaming }) => {
    if (!location.pathname.endsWith('/reader-engine.html')) return;
    const Native = AudioContext, connect = AudioNode.prototype.connect;
    const audioContext = new Native({ latencyHint: 'interactive', sinkId: { type: 'none' } });
    if (audioContext.sinkId?.type !== 'none') throw new Error('Silent capture requires a non-rendering sink.');
    const epoch = Date.now() / 1000 - audioContext.currentTime;
    const chunks = [], warnings = [];
    let recorder, firstFrame = null, nextFrame = null, claimed = false, flushed = null, samples = 0;
    let writes = Promise.resolve(), writeError = null, pendingBlocks = 0;
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
          samples += data.pcm.length;
          if (streaming) {
            if (++pendingBlocks > 8) { writeError = 'Capture writer fell behind'; pendingBlocks--; }
            else {
              const bytes = new Uint8Array(data.pcm.length * 4), view = new DataView(bytes.buffer);
              data.pcm.forEach((value, index) => view.setFloat32(index * 4, value, true));
              let binary = '';
              for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
              const encoded = btoa(binary);
              writes = writes.then(() => __pnWriteSilentCapture(encoded)).catch(error => { writeError = String(error); })
                .finally(() => { pendingBlocks--; });
            }
          } else chunks.push(data.pcm);
          nextFrame = data.frame + data.pcm.length;
        } else if (data.flushed) { flushed?.(); flushed = null; }
      };
      connect.call(recorder, audioContext.destination);
    })();
    globalThis.__silentOutputCapture = async () => {
      await __silentCaptureReady;
      await new Promise(resolve => { flushed = resolve; recorder.port.postMessage({ flush: true, stop: true }); });
      await writes;
      if (writeError) throw new Error(writeError);
      const rate = audioContext.sampleRate;
      const metadata = { startedEpochSeconds: epoch + firstFrame / rate, rate, channels: 1, captureWarnings: warnings,
        scope: 'Render-thread AudioWorklet capture with a non-rendering sink; browser physical output muted; excludes OS/device routing' };
      if (streaming) return { samples, metadata };
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
      return { base64: btoa(binary), metadata };
    };
  }, { streaming: Boolean(outputPath) });
  if (!outputPath) return null;
  return { close, async finish(page) {
    try {
      const { samples, metadata } = await page.evaluate(() => __silentOutputCapture());
      assert.equal(writtenBytes, samples * 4, 'Capture stream lost samples');
      assert(writtenBytes <= 0xffffffff - 36, 'Capture exceeds RIFF size limit');
      const header = Buffer.alloc(44);
      header.write('RIFF', 0); header.writeUInt32LE(36 + writtenBytes, 4); header.write('WAVEfmt ', 8);
      header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(1, 22);
      header.writeUInt32LE(metadata.rate, 24); header.writeUInt32LE(metadata.rate * 4, 28);
      header.writeUInt16LE(4, 32); header.writeUInt16LE(32, 34); header.write('data', 36); header.writeUInt32LE(writtenBytes, 40);
      assert.equal((await file.write(header, 0, 44, 0)).bytesWritten, 44);
      await writeFile(`${outputPath}.json`, JSON.stringify(metadata, null, 2));
    } finally { await close(); }
  } };
}
