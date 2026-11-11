import { PERSONAL_VOICE_REFERENCES_KEY, PLAYBACK_SETTINGS_KEY } from '../platform/storage/playback-settings-storage.js';

export const STORAGE_KEYS = Object.freeze({
  PLAYBACK_SETTINGS: PLAYBACK_SETTINGS_KEY,
  OMNIVOICE_PERSONAL_REFERENCES: PERSONAL_VOICE_REFERENCES_KEY,
  FLOATING_READER_PENDING_ACTION: 'floatingReaderPendingAction',
  READABLE_TAB_TARGET: 'readableTabTarget',
  GPU_CALIBRATION_CACHE: 'pagenarratorGpuCalibration.v1',
  INSTALLED_VOICE_IDS: 'installedVoiceIds',
  TTS_HARDWARE_PROBE: 'pagenarratorTtsHardwareProbe',
  TTS_HARDWARE_PROBE_SUMMARY: 'ttsHardwareProbeSummary',
  LOG_LEVEL: 'logLevel',
  VOICE_SETUP_PENDING: 'voiceSetupPending.v1',
});

export function getResumePositionStorageKey(url) {
  return `pos:${url || ''}`;
}
