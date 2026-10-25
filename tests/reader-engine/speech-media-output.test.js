import { expect, it, vi } from 'vitest';
import { createSpeechMediaOutput } from '../../src/lib/speech-media-output.js';

it('shares one output stream, disconnects consumed inputs and closes on read cleanup', () => {
  const nodes = [], contexts = [];
  class Context {
    constructor() { this.state = 'running'; this.destination = {}; this.close = vi.fn(async () => {}); contexts.push(this); }
    createMediaElementSource(audio) { const node = { audio, connect: vi.fn(), disconnect: vi.fn() }; nodes.push(node); return node; }
  }
  const output = createSpeechMediaOutput({ AudioContext: Context });
  const releaseFirst = output.connect({ id: 1 }); output.connect({ id: 2 });
  expect(contexts).toHaveLength(1); expect(nodes).toHaveLength(2);
  releaseFirst(); releaseFirst(); expect(nodes[0].disconnect).toHaveBeenCalledTimes(1);
  output.release(); output.release(); expect(nodes[1].disconnect).toHaveBeenCalledTimes(1);
  expect(contexts[0].close).toHaveBeenCalledTimes(1);
});

it('keeps native output when autoplay blocks the audio context', async () => {
  const createSource = vi.fn(), resume = vi.fn(async () => {});
  const output = createSpeechMediaOutput({ AudioContext: class {
    state = 'suspended'; resume = resume; createMediaElementSource = createSource;
  } });
  output.connect({}); await Promise.resolve();
  expect(resume).toHaveBeenCalledTimes(1); expect(createSource).not.toHaveBeenCalled();
});
