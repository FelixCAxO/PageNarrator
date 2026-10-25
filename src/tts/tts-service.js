import { selectDefaultVoiceRuntime } from './runtime/backend-policy.js';

export function createTtsService({
  selectedVoice = null,
  selectRuntime = selectDefaultVoiceRuntime,
  navigator = globalThis.navigator,
} = {}) {
  let voice = selectedVoice;
  let lastRuntimeDecision = null;

  return {
    get selectedVoice() {
      return voice;
    },
    setSelectedVoice(nextVoice) {
      voice = nextVoice;
      return voice;
    },
    async prepareRuntime(options = {}) {
      lastRuntimeDecision = await selectRuntime({
        navigator,
        ...options,
      });
      return lastRuntimeDecision;
    },
    getRuntimeDiagnostics() {
      return lastRuntimeDecision;
    },
    async synthesize(synthesizer, text, options = {}) {
      if (typeof synthesizer !== 'function') throw new Error('A TTS synthesizer is required.');
      return synthesizer(text, { voice, runtime: lastRuntimeDecision, ...options });
    },
    async dispose() {
      voice = null;
      lastRuntimeDecision = null;
    },
  };
}
