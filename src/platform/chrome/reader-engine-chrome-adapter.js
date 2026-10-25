import { createReaderEngineChromeAdapter as createReaderEngineSession } from '../../app/reader-engine/reader-engine-session.js';

export function createReaderEngineChromeAdapter(deps = {}) {
  return createReaderEngineSession(deps);
}
