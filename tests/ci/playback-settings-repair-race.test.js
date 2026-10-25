import { describe, expect, it } from 'vitest';
import { getPlaybackSettings, savePlaybackSettings } from '../../src/lib/playback-settings.js';

const KEY = 'playbackSettings';

// getPlaybackSettings() repairs missing or corrupt settings by writing normalized defaults.
// That repair must not overwrite a save that landed after the corrupt value was read.
describe('playback settings auto-repair', () => {
  it('does not clobber a save that lands between the repair read and write', async () => {
    const data = {};
    let firstRead = true;
    let releaseFirstRead;
    const storage = {
      async get(key) {
        const snapshot = structuredClone(data[key]);
        if (firstRead) {
          firstRead = false;
          await new Promise((resolve) => { releaseFirstRead = resolve; });
        }
        return { [key]: snapshot };
      },
      async set(values) { Object.assign(data, structuredClone(values)); },
    };

    const reading = getPlaybackSettings({ storage });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await savePlaybackSettings({ skipCodeSnippets: true, speed: 2 }, { storage });
    releaseFirstRead();
    await reading;

    expect(data[KEY].skipCodeSnippets).toBe(true);
    expect(data[KEY].speed).toBe(2);
  });

  it('still repairs settings that remain corrupt', async () => {
    const data = { [KEY]: { speed: 'fast' } };
    const storage = {
      async get(key) { return { [key]: structuredClone(data[key]) }; },
      async set(values) { Object.assign(data, structuredClone(values)); },
    };
    const settings = await getPlaybackSettings({ storage });
    expect(typeof data[KEY].speed).toBe('number');
    expect(settings.speed).toBe(data[KEY].speed);
  });
});
