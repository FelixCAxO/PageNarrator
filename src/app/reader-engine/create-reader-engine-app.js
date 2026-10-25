import { createReaderSession } from '../../reader/reader-session.js';
import { createReadRunner } from '../../reader/read-runner.js';
import { createTtsService } from '../../tts/tts-service.js';
import { createReaderEngineController } from '../../ui/reader-engine/reader-engine-controller.js';
import { createReaderEngineRuntimeApp } from './reader-engine-runtime.js';

export function createReaderEngineApp(deps = {}) {
  const session = createReaderSession();
  const ttsService = createTtsService({ navigator: deps.navigator });
  const readRunner = createReadRunner({ session });
  const controller = createReaderEngineController({ session, readRunner, ttsService });
  const runtimeDeps = {
    ...deps,
    productCore: {
      session,
      readRunner,
      ttsService,
      controller,
    },
  };

  /** @type {(deps: any) => any} */
  const createRuntimeApp = createReaderEngineRuntimeApp;
  return createRuntimeApp(runtimeDeps);
}
