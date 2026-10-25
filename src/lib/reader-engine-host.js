import { MESSAGE_TYPES } from './message-types.js';

export const READER_ENGINE_STATE_KEY = 'readerEngineState';

export async function ensureReaderEngine({ runtime, offscreen, engineUrl, delay = defaultDelay } = {}) {
  if (await pingReaderEngine(runtime)) return true;

  const contexts = await runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (!contexts.length) {
    await offscreen.createDocument({
      url: engineUrl,
      reasons: ['AUDIO_PLAYBACK', 'WORKERS'],
      justification: 'Keep on-device narration running while the toolbar popup is closed.',
    });
  }

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await pingReaderEngine(runtime)) return true;
    await delay(100);
  }
  throw new Error('PageNarrator player did not start.');
}

export async function sendReaderEngineAction({ runtime, offscreen, engineUrl, action, delay } = {}) {
  await ensureReaderEngine({ runtime, offscreen, engineUrl, delay });
  // ponytail: one runtime message is the only player action path.
  await runtime.sendMessage({
    type: MESSAGE_TYPES.READER_ENGINE_ACTION,
    action,
  });
}

async function pingReaderEngine(runtime) {
  try {
    const response = await runtime.sendMessage({ type: MESSAGE_TYPES.READER_ENGINE_PING });
    return response?.ready === true;
  } catch {
    return false;
  }
}

function defaultDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
