import { getReaderEnginePdfElements } from '../ui/reader-engine/elements/pdf-elements.js';
import { getReaderEnginePlayerElements } from '../ui/reader-engine/elements/player-elements.js';
import { getReaderEngineRecoveryElements } from '../ui/reader-engine/elements/recovery-elements.js';
import { getReaderEngineSettingsElements } from '../ui/reader-engine/elements/settings-elements.js';

export function getReaderEngineElements(documentRef = globalThis.document) {
  return {
    ...getReaderEnginePlayerElements(documentRef),
    ...getReaderEngineSettingsElements(documentRef),
    ...getReaderEnginePdfElements(documentRef),
    ...getReaderEngineRecoveryElements(documentRef),
  };
}
