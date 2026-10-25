import { selectVoiceModelBackend } from '../../lib/gpu-calibration.js';
import { createTtsPerformanceGovernor } from '../../lib/tts-performance-profile.js';
import { DEFAULT_RUNTIME_POLICY } from './default-runtime-policy.js';

export async function selectVoiceModelBackendPlan(options = {}) {
  return selectVoiceModelBackend(options);
}

export async function selectDefaultVoiceRuntime(options = {}) {
  const backendPlan = await selectVoiceModelBackendPlan(options);
  const governor = createTtsPerformanceGovernor({
    setting: DEFAULT_RUNTIME_POLICY.requestedProfile,
    navigator: options.navigator,
  });
  governor.recordBackendPlan(backendPlan);
  return Object.freeze({
    ...DEFAULT_RUNTIME_POLICY,
    preferredBackend: backendPlan.device === 'webgpu' ? 'webgpu' : 'wasm',
    backendPlan,
    resolvedProfile: governor.currentProfile(),
    profileConfig: governor.currentConfig(),
  });
}
