import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

// Stream clips out of Chromium so evidence collection does not retain an hour of audio.
export async function installSustainedEvidence(context, root) {
  const clips = [];
  await context.exposeFunction('__pnSaveSustainedClip', async ({ index, base64, ...metadata }) => {
    assert.equal(index, clips.length, 'Out-of-order clip export');
    assert(typeof base64 === 'string' && base64.length > 0 && base64.length <= 16 * 1024 * 1024, 'Invalid clip export');
    const bytes = Buffer.from(base64, 'base64');
    await writeFile(path.join(root, `clip-${index}.wav`), bytes, { flag: 'wx' });
    clips.push({ index, ...metadata, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  });
  await context.addInitScript(() => {
    if (!location.pathname.endsWith('/reader-engine.html')) return;
    const blobs = new Map(), played = new Set();
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL), play = HTMLMediaElement.prototype.play;
    globalThis.__sustained = { jobs: [], clipWrites: Promise.resolve(), clipError: null, exportedClips: 0, pendingClips: 0, runtime: null };
    URL.createObjectURL = blob => { const url = create(blob); if (blob.type === 'audio/wav') blobs.set(url, blob); return url; };
    URL.revokeObjectURL = url => { blobs.delete(url); played.delete(url); return revoke(url); };
    HTMLMediaElement.prototype.play = function (...args) {
      const url = this.currentSrc || this.src;
      if (blobs.has(url) && !played.has(url)) {
        played.add(url);
        if (globalThis.__sustained.pendingClips >= 2) {
          globalThis.__sustained.clipError = 'Clip export fell behind playback.';
          return play.apply(this, args);
        }
        globalThis.__sustained.pendingClips++;
        const blob = blobs.get(url), metadata = { rate: this.playbackRate, at: Date.now() };
        globalThis.__sustained.clipWrites = globalThis.__sustained.clipWrites.then(async () => {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = '';
          for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
          await __pnSaveSustainedClip({ index: globalThis.__sustained.exportedClips, base64: btoa(binary), ...metadata });
          globalThis.__sustained.exportedClips++;
        }).catch(error => { globalThis.__sustained.clipError = String(error); })
          .finally(() => { globalThis.__sustained.pendingClips--; });
      }
      return play.apply(this, args);
    };
    const NativeWorker = globalThis.Worker;
    globalThis.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        const pending = new Map(), post = this.postMessage.bind(this);
        this.postMessage = (message, ...options) => {
          if (message.method === 'synthesize') {
            const job = { id: message.id, ...message.request, started: Date.now() };
            pending.set(message.id, job); globalThis.__sustained.jobs.push(job);
          }
          return post(message, ...options);
        };
        this.addEventListener('message', ({ data }) => {
          if (data.result?.main) globalThis.__sustained.runtime = data.result;
          const job = pending.get(data.id);
          if (!job || data.synthesisProgress) return;
          pending.delete(data.id);
          Object.assign(job, { ended: Date.now(), error: data.error, frames: data.result?.pcm?.length,
            sampleRate: data.result?.sampleRate, speaker: data.result?.speaker, timings: data.result?.timings });
          if (data.result?.pcm) post({ id: -1, method: 'diagnostics' });
        });
      }
    };
  });
  return { clips, async finish(page) {
    return page.evaluate(async () => {
      await globalThis.__sustained.clipWrites;
      const { clipWrites: _writes, ...evidence } = globalThis.__sustained;
      return evidence;
    });
  } };
}
