import { BytePairTokenizer } from '../../engines/bytepair-tokenizer.js';
import * as browserInference from '../../engines/browser-inference.js';
import { createOmniVoiceDataFetch } from './data-loader.js';
import { OMNIVOICE_DATA } from './model-data.js';

export const OMNIVOICE_MODEL_REVISION = OMNIVOICE_DATA.revision;
export const OMNIVOICE_MODEL_BASE_URL = `https://huggingface.co/MarkShark2/omnivoice-onnx-kv-b1-fp16/resolve/${OMNIVOICE_MODEL_REVISION}`;

/** @param {any} [deps] */
export async function loadBundledRuntime({ onProgress = () => {} } = {}) {
  const { createOmniVoiceRuntime } = await import('./runtime.js');
  const fetchModel = createOmniVoiceDataFetch({ onProgress });
  const [tokenizerJson, tokenizerConfig] = await Promise.all(['tokenizer.json', 'tokenizer_config.json'].map(async file =>
    (await fetchModel(`${OMNIVOICE_MODEL_BASE_URL}/${file}`)).json()));
  const engine = browserInference.createBrowserInferenceEngine({ float16: true });
  return createOmniVoiceRuntime({ ort: engine, decoderRuntime: engine, tokenizer: new BytePairTokenizer(tokenizerJson, tokenizerConfig), fetch: fetchModel,
    log: (/** @type {string} */ stage, /** @type {string} */ detail) => { if (stage === 'loading' || stage === 'downloading') onProgress({ message: detail }); } });
}
