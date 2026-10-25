import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { DEEP_FLOW_TTS_PROBE_PROFILE_SET, getTtsProbeProfiles } from './live-tts-hardware-profiles.js';
import { getTtsProbeDocumentTypes } from './live-tts-hardware-probe-documents.js';

import { PROBE_WORKLOADS } from './tts-probe-workloads.js';

import { SCHEDULING_MODES } from '../../scripts/weak-hardware/evidence-contract.mjs';

import { createRunId } from '../../scripts/weak-hardware/run-provenance.mjs';

export const RUN_TTS_PROBE = process.env.PAGENARRATOR_TTS_PROBE === '1';

export const PROBE_TIMEOUT_MS = Number(process.env.PAGENARRATOR_TTS_PROBE_TIMEOUT_MS || 900_000);

export const ROOT_DIR = path.resolve(import.meta.dirname, '../..');

export const DIST_DIR = path.resolve(process.env.PAGENARRATOR_TTS_PROBE_EXTENSION_DIR || path.join(ROOT_DIR, 'dist'));

export const PROBE_PROFILE_SELECTION = process.env.PAGENARRATOR_TTS_PROBE_PROFILE
  || process.env.PAGENARRATOR_TTS_PROBE_MATRIX
  || '';

export const PROBE_PROFILES = getTtsProbeProfiles(PROBE_PROFILE_SELECTION);

export const PROBE_DOCUMENT_TYPES = getTtsProbeDocumentTypes(
  process.env.PAGENARRATOR_TTS_PROBE_DOCUMENTS || process.env.PAGENARRATOR_TTS_PROBE_DOCUMENT || '',
  { profileSelection: PROBE_PROFILE_SELECTION },
);

export const PROBE_TOTAL_RUNS = PROBE_PROFILES.reduce((total, profile) => (
  total + getProfileDocumentTypes(profile).reduce((sum, documentType) => (
    sum + (getProbeRunCount(profile, documentType) * getReadsPerTarget(documentType))
  ), 0)
), 0);

export const PROBE_SOAK_MS = PROBE_PROFILES.reduce((total, profile) => total + (profile.soak ? getSoakDurationMs(profile) : 0), 0);

// Upper bound per attempt: page setup and backend waits (~3 min), the synthesis
// wait and the cleanup wait (each up to PROBE_TIMEOUT_MS). Plus browser launch
// and host sampling per profile. Inner waits must fire first so every attempt
// is recorded before Vitest could abandon the test.
export const PROBE_TEST_TIMEOUT_MS = (Math.max(1, PROBE_TOTAL_RUNS) * ((2 * PROBE_TIMEOUT_MS) + 240_000))
  + (PROBE_PROFILES.length * 120_000)
  + PROBE_SOAK_MS;

export const PROBE_MIN_SECTIONS = Number(process.env.PAGENARRATOR_TTS_PROBE_MIN_SECTIONS || (
  PROBE_PROFILE_SELECTION === DEEP_FLOW_TTS_PROBE_PROFILE_SET ? 3 : 1
));

export const CHROME_EXE = process.env.PAGENARRATOR_CHROME
  || path.join(ROOT_DIR, '.chrome-for-testing', 'chrome-win64', 'chrome.exe');

export const RUN_ID = process.env.PAGENARRATOR_TTS_PROBE_RUN_ID || createRunId();

export const SCHEDULING_MODE = process.env.PAGENARRATOR_TTS_PROBE_MODE === SCHEDULING_MODES.CONTENTION
  ? SCHEDULING_MODES.CONTENTION
  : SCHEDULING_MODES.ISOLATED;

export const SUPERVISOR_REQUEST = process.env.PAGENARRATOR_TTS_PROBE_SUPERVISOR || 'auto';

export const NATIVE_BACKGROUNDING = process.env.PAGENARRATOR_TTS_PROBE_NATIVE_BACKGROUNDING === '1';

export const PROBE_SPEED = Number(process.env.PAGENARRATOR_TTS_PROBE_SPEED || 0) || null;

// Consecutive failed attempts after which a profile stops (each can take PROBE_TIMEOUT_MS).
export const MAX_CONSECUTIVE_FAILURES = Number(process.env.PAGENARRATOR_TTS_PROBE_MAX_CONSECUTIVE_FAILURES || 2);

// Visible probe windows are opt-in; native-backgrounding lanes still need a real window.
export const HEADLESS = process.env.PAGENARRATOR_HEADED !== '1';

export const PREPARED_EXTENSION_MODIFICATIONS = Object.freeze(['manifest.host_permissions += http://127.0.0.1/* (local probe article access)']);

export const TTS_HARDWARE_PROBE_STORAGE_KEY = 'pagenarratorTtsHardwareProbe';

export const READABLE_TAB_TARGET_KEY = 'readableTabTarget';


export const PLAYBACK_SETTINGS_KEY = 'playbackSettings';

export const TEST_HOOKS_KEY = 'pnTestHooksEnabled';

export const TEST_FORCE_KOKORO_FAILURE_KEY = 'pnTestForceKokoroFailure';

export function sanitizePathPart(value) {
  return String(value || 'profiles').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'profiles';
}

export class ProbeTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProbeTimeoutError';
  }
}

export class ProbeCrashError extends Error {
  constructor(message, crash) {
    super(message);
    this.name = 'ProbeCrashError';
    this.crash = crash;
  }
}

export async function waitFor(condition, message, timeoutMs = 30_000) {
  const started = Date.now();
  let value;
  while (Date.now() - started < timeoutMs) {
    value = await condition();
    if (value) return value;
    await delay(250);
  }
  throw new ProbeTimeoutError(typeof message === 'function' ? message() : message);
}

export function getRequiredProbeSections(profile, documentType = 'article') {
  // The default v3 PDF deliberately exercises a real section handoff.
  if (documentType === 'pdf') return 2;
  // Other PDF workloads may be a single section (the two-column fixture is).
  if (PROBE_WORKLOADS[documentType]?.kind === 'pdf') return 1;
  const profileMinimum = Number(profile?.minProbeSections);
  if (Number.isFinite(profileMinimum) && profileMinimum > 0) return Math.trunc(profileMinimum);
  return Number.isFinite(PROBE_MIN_SECTIONS) && PROBE_MIN_SECTIONS > 0 ? Math.trunc(PROBE_MIN_SECTIONS) : 1;
}

export function getProbeRunCount(profile, documentType = 'article') {
  // Lanes defined by per-run conditions (warm-up, offline, restart) keep their sequence.
  if (profile?.runConditions?.length) return profile.runConditions.length;
  const override = Number(process.env.PAGENARRATOR_TTS_PROBE_RUNS);
  if (Number.isFinite(override) && override > 0) return Math.trunc(override);
  if (documentType === 'pdf') return 1;
  const profileRuns = Number(profile?.runs);
  return Number.isFinite(profileRuns) && profileRuns > 0 ? Math.trunc(profileRuns) : 1;
}

// Lanes may read their own workloads (e.g. the soak article).
export function getProfileDocumentTypes(profile) {
  return profile?.documentTypes?.length ? profile.documentTypes : PROBE_DOCUMENT_TYPES;
}

// Soak duration: the lane's target unless an exploratory override is set (the
// result then records the shortfall against the target).
export function getSoakDurationMs(profile) {
  const override = Number(process.env.PAGENARRATOR_TTS_PROBE_SOAK_MS);
  return Number.isFinite(override) && override > 0 ? Math.trunc(override) : profile.soak.targetMs;
}

// Reads per toolbar-player page: the first loads the model, later ones are warm.
export function getReadsPerTarget() {
  const reads = Number(process.env.PAGENARRATOR_TTS_PROBE_READS_PER_TARGET);
  return Number.isFinite(reads) && reads > 1 ? Math.trunc(reads) : 1;
}

export function getProbeSpeed(profile) {
  return PROBE_SPEED || Number(profile?.playbackSettings?.speed) || 1;
}

export const probeState = { lock: null };
