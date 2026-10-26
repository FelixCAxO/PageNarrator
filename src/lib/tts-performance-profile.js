import { t } from './i18n.js';
import { TUNING_CONFIG } from './tuning-config.js';

export const TTS_PERFORMANCE_PROFILE_DEFAULT = 'auto';

const SLOW_CPU_REAL_TIME_FACTOR = TUNING_CONFIG.ttsProfiles.slowCpuRealTimeFactor;
const SLOW_MODEL_LOAD_MS = TUNING_CONFIG.ttsProfiles.slowModelLoadMs;
const SLOW_SECTION_TRANSITION_MS = TUNING_CONFIG.ttsProfiles.slowSectionTransitionMs;
const LOW_POWER_MEMORY_GB = TUNING_CONFIG.ttsProfiles.lowPowerMemoryGb;
const BALANCED_MEMORY_GB = TUNING_CONFIG.ttsProfiles.balancedMemoryGb;
const LOW_CORE_CPU_COUNT = TUNING_CONFIG.ttsProfiles.lowCoreCpuCount;

const PROFILES = Object.freeze(['auto', 'quality', 'balanced', 'lowPower']);

const PROFILE_CONFIGS = TUNING_CONFIG.ttsProfiles.configs;
const BALANCED_CPU_CONFIG = Object.freeze({
  ...PROFILE_CONFIGS.lowPower,
  profile: 'balanced',
  preloadAhead: 3,
  progressiveSegments: false,
});

const PROFILE_LABELS = Object.freeze({
  auto: t("Auto"),
  quality: t("High quality"),
  balanced: t("Balanced"),
  lowPower: t("Battery saver"),
});

export function normalizeTtsPerformanceProfile(value) {
  const profile = String(value || '').trim();
  return PROFILES.includes(profile) ? profile : TTS_PERFORMANCE_PROFILE_DEFAULT;
}

export function getTtsPerformanceProfileConfig(profile) {
  const normalized = normalizeTtsPerformanceProfile(profile);
  return PROFILE_CONFIGS[normalized] || PROFILE_CONFIGS.balanced;
}

export function formatTtsPerformanceProfileOptionLabel(profile, currentProfile = null) {
  const normalized = normalizeTtsPerformanceProfile(profile);
  const label = PROFILE_LABELS[normalized] || PROFILE_LABELS.auto;
  if (normalized !== 'auto') return label;

  const current = normalizeResolvedTtsPerformanceProfile(currentProfile);
  return current ? `${label} - ${PROFILE_LABELS[current]}` : label;
}

export function formatTtsPerformanceProfileTooltip(profile, config = null) {
  const normalized = normalizeResolvedTtsPerformanceProfile(profile) || 'balanced';
  const activeConfig = config || getTtsPerformanceProfileConfig(normalized);
  const preloadLabel = activeConfig.preloadAhead === 1 ? t("1 section preloaded") : t("$1 sections preloaded", [activeConfig.preloadAhead]);
  const progressiveLabel = activeConfig.progressiveSegments ? t("progressive playback on") : t("progressive playback off");
  const voiceLabel = t("automatic browser voice switching off");

  return t("$1: $2-character chunks, $3, $4, $5.", [PROFILE_LABELS[normalized], activeConfig.maxChunkLength, preloadLabel, progressiveLabel, voiceLabel]);
}

function normalizeResolvedTtsPerformanceProfile(value) {
  const profile = String(value || '').trim();
  return profile && profile !== 'auto' && PROFILES.includes(profile) ? profile : null;
}

export function resolveBalancedProfileForBackend({
  backend = null,
  cpuBudgetTarget = false,
} = {}) {
  if (backend === 'wasm' || cpuBudgetTarget) return BALANCED_CPU_CONFIG;
  return PROFILE_CONFIGS.balanced;
}

export function createTtsPerformanceGovernor({
  setting = TTS_PERFORMANCE_PROFILE_DEFAULT,
  navigator = globalThis.navigator,
  hardwareProbeSummary = null,
} = {}) {
  const requestedProfile = normalizeTtsPerformanceProfile(setting);
  let currentProfile = requestedProfile === 'auto'
    ? getAutoProfile(navigator)
    : requestedProfile;
  let runtimeCpuBudgetTarget = isCpuTarget(navigator);
  let runtimeBackend = getInitialRuntimeBackend({ requestedProfile, navigator });
  const cachedProbeProfile = getCachedProbeInitialProfile(hardwareProbeSummary, { requestedProfile, navigator });
  if (cachedProbeProfile) currentProfile = cachedProbeProfile;
  if (hardwareProbeSummary?.selectedBackendPlan?.device) {
    runtimeBackend = hardwareProbeSummary.selectedBackendPlan.device;
  }
  if (typeof hardwareProbeSummary?.selectedBackendPlan?.cpuBudgetTarget === 'boolean') {
    runtimeCpuBudgetTarget = hardwareProbeSummary.selectedBackendPlan.cpuBudgetTarget;
  }
  let firstSynthesisRecorded = false;
  let consecutiveSlowSectionTransitions = 0;
  let balancedPreloadAheadOverride = null;

  const canRetierFromRuntime = () => requestedProfile === 'auto';
  const canSubDowngradeBalanced = () => requestedProfile === 'balanced';
  const canRetierFromBackendPlan = () => requestedProfile === 'auto';
  const isRuntimeCpuTarget = () => runtimeCpuBudgetTarget || isCpuTarget(navigator);
  const applyRuntimeDowngrade = (previousProfile) => {
    if (canRetierFromRuntime() && currentProfile === 'balanced' && isRuntimeCpuTarget()) {
      return {
        changed: false,
        subDowngrade: null,
      };
    }
    if (canRetierFromRuntime()) {
      currentProfile = 'lowPower';
      return {
        changed: currentProfile !== previousProfile,
        subDowngrade: null,
      };
    }
    if (canSubDowngradeBalanced() && currentProfile === 'balanced') {
      const previousOverride = balancedPreloadAheadOverride;
      balancedPreloadAheadOverride = 0;
      return {
        changed: previousOverride !== balancedPreloadAheadOverride,
        subDowngrade: 'balanced-preload-ahead-zero',
      };
    }
    return {
      changed: false,
      subDowngrade: null,
    };
  };

  return {
    requestedProfile() {
      return requestedProfile;
    },
    currentProfile() {
      return currentProfile;
    },
    currentConfig() {
      // Smaller CPU chunks keep synthesis ahead of audio across short headings.
      if (currentProfile === 'quality' && isRuntimeCpuTarget()) {
        return { ...BALANCED_CPU_CONFIG, profile: 'quality' };
      }
      if (currentProfile === 'balanced') {
        const config = resolveBalancedProfileForBackend({
          backend: runtimeBackend,
          cpuBudgetTarget: isRuntimeCpuTarget(),
          cpuCount: navigator?.hardwareConcurrency,
        });
        return balancedPreloadAheadOverride === null
          ? config
          : Object.freeze({ ...config, preloadAhead: balancedPreloadAheadOverride });
      }
      return getTtsPerformanceProfileConfig(currentProfile);
    },
    recordBackendPlan(plan = {}) {
      const previousProfile = currentProfile;
      if (plan.device) runtimeBackend = plan.device;
      if (typeof plan.cpuBudgetTarget === 'boolean') {
        runtimeCpuBudgetTarget = plan.cpuBudgetTarget;
      } else if (plan.device) {
        runtimeCpuBudgetTarget = plan.device !== 'webgpu';
      }

      if (
        canRetierFromBackendPlan()
        && currentProfile === 'quality'
        && runtimeCpuBudgetTarget
      ) {
        currentProfile = getAutoCpuProfile(navigator);
      }
      if (
        canRetierFromBackendPlan()
        && currentProfile === 'balanced'
        && plan.device === 'webgpu'
        && runtimeCpuBudgetTarget === false
      ) {
        currentProfile = 'quality';
      }

      return {
        changed: currentProfile !== previousProfile,
        previousProfile,
        nextProfile: currentProfile,
        reason: plan.reason || 'backend-plan',
        device: plan.device || null,
        dtype: plan.dtype || null,
      };
    },
    recordModelLoad({ loadMs } = {}) {
      const previousProfile = currentProfile;
      const numericLoadMs = Number(loadMs);
      let downgrade = { changed: false, subDowngrade: null };
      if (
        (canRetierFromRuntime() || canSubDowngradeBalanced())
        && currentProfile !== 'lowPower'
        && isRuntimeCpuTarget()
        && Number.isFinite(numericLoadMs)
        && numericLoadMs >= SLOW_MODEL_LOAD_MS
      ) {
        downgrade = applyRuntimeDowngrade(previousProfile);
      }

      return {
        changed: downgrade.changed,
        previousProfile,
        nextProfile: currentProfile,
        reason: downgrade.changed ? 'slow-model-load' : 'model-load-ok',
        loadMs: Number.isFinite(numericLoadMs) ? numericLoadMs : null,
        subDowngrade: downgrade.subDowngrade,
      };
    },
    recordFirstSynthesis({ synthesisMs, audioDurationSeconds } = {}) {
      const previousProfile = currentProfile;
      const realTimeFactor = getSynthesisRealTimeFactor({ synthesisMs, audioDurationSeconds });
      let downgrade = { changed: false, subDowngrade: null };
      if (
        !firstSynthesisRecorded
        && (canRetierFromRuntime() || canSubDowngradeBalanced())
        && currentProfile !== 'lowPower'
        && isRuntimeCpuTarget()
        && Number.isFinite(realTimeFactor)
        && realTimeFactor >= SLOW_CPU_REAL_TIME_FACTOR
      ) {
        downgrade = applyRuntimeDowngrade(previousProfile);
      }
      firstSynthesisRecorded = true;

      return {
        changed: downgrade.changed,
        previousProfile,
        nextProfile: currentProfile,
        reason: downgrade.changed ? 'slow-first-synthesis' : 'first-synthesis-ok',
        realTimeFactor,
        subDowngrade: downgrade.subDowngrade,
      };
    },
    recordSectionTransition({ nextSectionReadyGapMs, unplannedGapMs, pauseAppliedMs } = {}) {
      const previousProfile = currentProfile;
      const observedGapMs = getObservedSectionTransitionGapMs({
        nextSectionReadyGapMs,
        unplannedGapMs,
        pauseAppliedMs,
      });
      if (Number.isFinite(observedGapMs) && observedGapMs >= SLOW_SECTION_TRANSITION_MS) {
        consecutiveSlowSectionTransitions += 1;
      } else {
        consecutiveSlowSectionTransitions = 0;
      }

      let downgrade = { changed: false, subDowngrade: null };
      if (
        consecutiveSlowSectionTransitions >= 2
        && (canRetierFromRuntime() || canSubDowngradeBalanced())
        && currentProfile !== 'lowPower'
        && isRuntimeCpuTarget()
      ) {
        downgrade = applyRuntimeDowngrade(previousProfile);
      }

      return {
        changed: downgrade.changed,
        previousProfile,
        nextProfile: currentProfile,
        reason: downgrade.changed ? 'slow-section-transition' : 'section-transition-ok',
        nextSectionReadyGapMs: Number.isFinite(Number(nextSectionReadyGapMs)) ? Number(nextSectionReadyGapMs) : null,
        unplannedGapMs: Number.isFinite(observedGapMs) ? observedGapMs : null,
        slowTransitionCount: consecutiveSlowSectionTransitions,
        subDowngrade: downgrade.subDowngrade,
      };
    },
  };
}

export function getSynthesisRealTimeFactor({ synthesisMs, audioDurationSeconds } = {}) {
  const ms = Number(synthesisMs);
  const seconds = Number(audioDurationSeconds);
  if (!Number.isFinite(ms) || ms < 0 || !Number.isFinite(seconds) || seconds <= 0) return null;
  return ms / (seconds * 1000);
}

function getAutoProfile(navigator) {
  if (isLowMemoryDevice(navigator) || isLowCoreDevice(navigator)) return 'lowPower';
  if (isBalancedAutoCpuTarget(navigator)) return 'balanced';
  return navigator?.gpu ? 'quality' : 'balanced';
}

function getAutoCpuProfile(navigator) {
  return isLowMemoryDevice(navigator) || isLowCoreDevice(navigator) ? 'lowPower' : 'balanced';
}

function isLowMemoryDevice(navigator) {
  const memory = Number(navigator?.deviceMemory);
  return Number.isFinite(memory) && memory <= LOW_POWER_MEMORY_GB;
}

function isBalancedAutoCpuTarget(navigator) {
  const memory = Number(navigator?.deviceMemory);
  return Number.isFinite(memory) && memory <= BALANCED_MEMORY_GB && memory > LOW_POWER_MEMORY_GB;
}

function isLowCoreDevice(navigator) {
  const cores = Number(navigator?.hardwareConcurrency);
  return Number.isFinite(cores) && cores <= LOW_CORE_CPU_COUNT;
}

function isCpuTarget(navigator) {
  if (!navigator?.gpu) return true;
  return isLowMemoryDevice(navigator) || isLowCoreDevice(navigator);
}

function getInitialRuntimeBackend({ requestedProfile, navigator } = {}) {
  if (requestedProfile === 'balanced' || requestedProfile === 'lowPower') return 'wasm';
  return isCpuTarget(navigator) ? 'wasm' : 'webgpu';
}

function getObservedSectionTransitionGapMs({ nextSectionReadyGapMs, unplannedGapMs, pauseAppliedMs } = {}) {
  const unplanned = Number(unplannedGapMs);
  if (Number.isFinite(unplanned)) return Math.max(0, unplanned);

  const gap = Number(nextSectionReadyGapMs);
  if (!Number.isFinite(gap)) return null;
  const pause = Number(pauseAppliedMs);
  return Math.max(0, gap - (Number.isFinite(pause) ? Math.max(0, pause) : 0));
}

function getCachedProbeInitialProfile(summary, { requestedProfile, navigator } = {}) {
  if (requestedProfile !== 'auto') return null;
  const realTimeFactor = Number(summary?.realTimeFactor);
  const plan = summary?.selectedBackendPlan || {};
  const cpuTarget = plan.cpuBudgetTarget === true || plan.device === 'wasm' || isCpuTarget(navigator);
  if (cpuTarget && Number.isFinite(realTimeFactor) && realTimeFactor >= SLOW_CPU_REAL_TIME_FACTOR) {
    return getAutoCpuProfile(navigator);
  }
  return null;
}
