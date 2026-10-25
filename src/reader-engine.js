// @ts-check
import { isTrustedBackgroundSender } from './lib/extension-message-security.js';
import { installTrustedUiEventBoundary } from './lib/trusted-ui-events.js';

installTrustedUiEventBoundary(document);
const isReaderEngine = new URL(location.href).searchParams.get('engine') === '1';
if (isReaderEngine) await import('./lib/offscreen-chrome-bridge.js');

const [
  { localizeDocument },
  { installRecoverableWebGpuErrorSuppression },
  { createReaderEngineApp },
  { MESSAGE_TYPES },
  { getFlowLog },
] = await Promise.all([
  import('./lib/i18n.js'),
  import('./lib/recoverable-webgpu-errors.js'),
  import('./lib/reader-engine-app.js'),
  import('./lib/message-types.js'),
  import('./lib/flow-recorder.js'),
]);

// ponytail: Kokoro falls back to WASM; Chrome can still report the recovered WebGPU probe rejection.
installRecoverableWebGpuErrorSuppression(window);
localizeDocument(document);

let readerEngineReady = false;
let readerEngineError = '';
globalThis.__pnReaderEngineInitStage = 'starting';
if (isReaderEngine) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isTrustedBackgroundSender(sender, chrome.runtime)) return false;
    if (message?.type === MESSAGE_TYPES.GET_FLOW_LOG) {
      sendResponse({
        log: getFlowLog(globalThis),
        hardwareProbe: globalThis.__pagenarratorTtsProbe?.result || null,
      });
      return false;
    }
    if (message?.type !== MESSAGE_TYPES.READER_ENGINE_PING) return false;
    sendResponse({ ready: readerEngineReady, stage: globalThis.__pnReaderEngineInitStage, error: readerEngineError });
    return false;
  });
}

void createReaderEngineApp({ document, chrome, navigator, performance }).start().then(() => {
  globalThis.__pnReaderEngineInitStage = 'ready';
  readerEngineReady = true;
}).catch((error) => {
  readerEngineError = error instanceof Error ? error.message : String(error);
  globalThis.__pnReaderEngineInitStage = 'error';
});
