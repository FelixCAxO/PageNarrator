import { describe, expect, it, vi } from 'vitest';
import { playProgressiveSpeechSegments } from '../../src/lib/progressive-segment-playback.js';

function createFakeAudio() {
  const target = new EventTarget();
  return {
    src: '',
    currentTime: 0,
    duration: 1,
    playbackRate: 1,
    paused: false,
    ended: false,
    onended: null,
    onerror: null,
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
    load: vi.fn(),
    removeAttribute(name) {
      if (name === 'src') this.src = '';
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent(event) {
      return target.dispatchEvent(event);
    },
  };
}

function createSegment(text) {
  return {
    text,
    blob: new Blob([text]),
    wordTimings: [{ text, start: 0, end: 0.5 }],
  };
}

describe('progressive segment playback', () => {
  it('predecodes the next segment while the current segment is still playing', async () => {
    const firstSegment = createSegment('one');
    const secondSegment = createSegment('two');
    let resolveFirstPlayback;
    const firstPlayback = new Promise((resolve) => {
      resolveFirstPlayback = resolve;
    });
    const preparedSecondAudio = {
      audio: createFakeAudio(),
      managedUrl: { url: 'blob:two', revoke() {} },
      cleanup: vi.fn(),
    };
    const audioPlaybackManager = {
      playAudio: vi.fn(() => firstPlayback),
    };
    const prepareSegmentAudio = vi.fn(async (segment) => {
      if (segment === secondSegment) return preparedSecondAudio;
      return {
        audio: createFakeAudio(),
        managedUrl: { url: `blob:${segment.text}`, revoke() {} },
        cleanup: vi.fn(),
      };
    });

    const playback = playProgressiveSpeechSegments({
      segments: (async function* () {
        yield firstSegment;
        yield secondSegment;
      }()),
    }, { speech: 'one two' }, {
      sectionIndex: 4,
      audioPlaybackManager,
      createProgressiveSegmentChunk: (_chunk, segment) => ({ speech: segment.text }),
      prepareSegmentAudio,
    });

    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(audioPlaybackManager.playAudio).toHaveBeenCalledTimes(1);
    expect(audioPlaybackManager.playAudio.mock.calls[0][3]).toMatchObject({ canAdvanceEarly: false });
    expect(prepareSegmentAudio).toHaveBeenCalledTimes(1);
    expect(prepareSegmentAudio).toHaveBeenCalledWith(
      secondSegment,
      expect.objectContaining({ signal: null, runId: null }),
    );

    const onBeforeNormalEnd = audioPlaybackManager.playAudio.mock.calls[0][3].onBeforeNormalEnd;
    await expect(onBeforeNormalEnd()).resolves.toEqual({ preparedAudio: preparedSecondAudio });

    resolveFirstPlayback();
    await playback;
  });

  it('uses the final segment pre-end hook to prepare the next chunk handoff', async () => {
    const finalSegment = createSegment('last segment');
    const nextChunkHandoff = { preparedAudio: { audio: createFakeAudio() } };
    const onBeforeNormalEnd = vi.fn(async (event) => ({
      ...nextChunkHandoff,
      phase: event?.phase,
    }));
    const handoffs = [];
    const audioPlaybackManager = {
      playAudio: vi.fn(async (_blob, _wordTimings, _chunk, options) => {
        handoffs.push(await options.onBeforeNormalEnd({ phase: 'pre-end' }));
      }),
    };

    await playProgressiveSpeechSegments({
      segments: (async function* () {
        yield finalSegment;
      }()),
    }, { speech: 'last segment' }, {
      sectionIndex: 8,
      audioPlaybackManager,
      createProgressiveSegmentChunk: (_chunk, segment) => ({ speech: segment.text }),
      onBeforeNormalEnd,
    });

    expect(onBeforeNormalEnd).toHaveBeenCalledWith({ phase: 'pre-end' });
    expect(handoffs).toEqual([{ ...nextChunkHandoff, phase: 'pre-end' }]);
  });
});
