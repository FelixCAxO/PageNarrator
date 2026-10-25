import { createReaderEngineChromeAdapter } from '../../platform/chrome/reader-engine-chrome-adapter.js';
import { createReaderSession } from '../../reader/reader-session.js';
import { createReadRunner } from '../../reader/read-runner.js';
import { createTtsService } from '../../tts/tts-service.js';
import { createReaderEngineController } from '../../ui/reader-engine/reader-engine-controller.js';

// Controller graph contract: Init order: storage, targets, settings, preload, read loop. Teardown order: abort run, stop audio, clear preloads, release runtimes. One owner per signal: each controller owns only the abort signal it creates.
/** @param {any} [deps] */
export function createReaderEngineRuntimeApp({
  document,
  chrome,
  navigator,
  performance,
  window,
  productCore,
} = {}) {
  const core = productCore ?? createDefaultReaderEngineProductCore({ navigator });
  const { session, readRunner, ttsService, controller } = core;
  return createReaderEngineChromeAdapter({
    document,
    chrome,
    navigator,
    performance,
    window,
    productCore: { session, readRunner, ttsService, controller },
  });
}

/** @param {{ navigator?: any }} [deps] */
function createDefaultReaderEngineProductCore({ navigator } = {}) {
  const session = createReaderSession();
  const ttsService = createTtsService({ navigator });
  const readRunner = createReadRunner({ session });
  const controller = createReaderEngineController({ session, readRunner, ttsService });
  return {
    session,
    readRunner,
    ttsService,
    controller,
  };
}
