import { probePdfOcrAdapterFailures } from './tts-probe-ocr.js';
import { mkdir, writeFile } from 'node:fs/promises';

import path from 'node:path';

import { expect } from 'vitest';
import { summarizeTtsProbeRuns } from './live-tts-hardware-profiles.js';

import { assessMeasurementValidity, assessRunEnvironment, classifyProbeOutcome, resolveExecutionBackend, pageBlockingFailures, summarizeAudioTap, summarizeMainThread, summarizeModelAcquisition, summarizeSectionReadyDeadlines, summarizeSectionTimeline, summarizeWorkerThreads } from './tts-probe-observations.js';

import { RESULT_SCHEMA_VERSION, RUN_STATUS, SCHEDULING_MODES } from '../../scripts/weak-hardware/evidence-contract.mjs';
import { computeGpuEngineUsage, computeJobCpuUsage } from '../../scripts/weak-hardware/windows-job.mjs';

import { computeBusyFraction } from '../../scripts/weak-hardware/host-load.mjs';

import { RUN_ID, SCHEDULING_MODE, getProbeSpeed, probeState } from './tts-probe-settings.js';
import { describeProbeProfile } from './tts-probe-environment.js';

export function expectExpectedBackendReason(profile, probe) {
  const expectedBackendReason = profile?.requirement?.gpu?.expectedBackendReason
    || profile?.gpu?.expectedBackendReason;
  if (!expectedBackendReason) return;
  expect(probe?.result?.selectedBackendPlan?.reason).toBe(expectedBackendReason);
}

export async function writeProbeOutput(runContext, attempts, lanes = []) {
  const passed = attempts.filter((attempt) => attempt.status === RUN_STATUS.PASSED);
  const payload = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    run: runContext.run,
    // Legacy readers: successful outputs only. Every attempt, including
    // failures, timeouts, crashes and invalid environments, is in attempts.
    profiles: passed,
    attempts,
    summaries: summarizeProbeOutputsByProfile(passed),
    lanes,
  };
  await mkdir(path.dirname(runContext.outputPath), { recursive: true });
  await writeFile(runContext.outputPath, `${JSON.stringify(payload, null, 2)}
`);
}

export function summarizeProbeOutputsByProfile(outputs) {
  const byProfile = new Map();
  for (const output of outputs) {
    const key = `${output?.profile?.name || 'unknown'}:${output?.documentType || 'article'}`;
    if (!byProfile.has(key)) byProfile.set(key, []);
    byProfile.get(key).push(output);
  }
  return [...byProfile.entries()].map(([key, runs]) => ({
    profileName: runs[0]?.profile?.name || key,
    documentType: runs[0]?.documentType || 'article',
    ...summarizeTtsProbeRuns(runs),
  }));
}

export function createAttemptRecord({ profile, documentTarget, runIndex, runCount }) {
  return {
    attemptId: `${RUN_ID}:${profile.name}:${documentTarget?.documentType || 'unknown'}:${runIndex}`,
    runId: RUN_ID,
    schedulingMode: SCHEDULING_MODE,
    documentType: documentTarget?.documentType || null,
    documentTitle: documentTarget?.title || null,
    documentUrl: documentTarget?.url || null,
    documentSha256: documentTarget?.sha256 || null,
    profile: describeProbeProfile(profile),
    runIndex,
    runCount,
    status: null,
    outcome: null,
    error: null,
    startedAt: new Date().toISOString(),
  };
}

export function finalizeAttempt({
  attempt,
  profile,
  probe,
  page,
  output,
  assertionFailures,
  timedOut,
  enforcementBefore,
  enforcementAfter,
  gpuBefore,
  gpuAfter,
  heap,
  ticksBefore,
  ticksAfter,
  startedAtMs,
  hostLoadBefore,
  browser,
  workers,
  pageBlocking = null,
}) {
  const tts = output?.tts || probe?.result || null;
  if (tts) tts.flow = { ...tts.flow, ...summarizeSectionReadyDeadlines(tts.sections) };
  if (output) Object.assign(attempt, { chrome: output.chrome, webgpu: output.webgpu, host: output.host, derived: output.derived, tts });
  else if (tts) attempt.tts = tts;
  attempt.page = page;
  if (pageBlocking) {
    attempt.pageBlocking = pageBlocking;
    assertionFailures.push(...pageBlockingFailures(pageBlocking));
  }
  attempt.workers = summarizeWorkerThreads(workers);
  attempt.execution = resolveExecutionBackend(tts || {});
  attempt.outcome = classifyProbeOutcome({ tts, page, crash: attempt.crash || null, timedOut });
  attempt.audio = summarizeAudioTap(page?.audio, { clickEpochMs: attempt.clickEpochMs });
  attempt.mainThread = summarizeMainThread(page?.mainThread);
  const speed = getProbeSpeed(profile);
  attempt.playback = {
    speed,
    // Synthesis must outpace consumption at the selected speed: below 1 keeps up.
    speedAdjustedRealTimeFactor: Number.isFinite(tts?.realTimeFactor) ? tts.realTimeFactor * speed : null,
    ...summarizeSectionTimeline(tts, { speed }),
  };
  attempt.modelAcquisition = summarizeModelAcquisition(page?.modelResources);
  attempt.measurementSources = {
    firstAudibleMs: 'first read: media playback callback; repeated read: in-page tap segments (neither is output loopback)',
    audioClickToFirstNonSilentMs: 'in-page media-element capture (not output loopback)',
    audioTotalsScope: 'page lifetime; first signal latency is scoped to this read',
    mainThreadScope: 'toolbar-player page lifetime',
    modelLoadMs: 'includes model download when modelCache.state is download-cold',
  };
  const jobCpu = computeJobCpuUsage(enforcementBefore?.accounting, enforcementAfter?.accounting);
  const gpuUsage = gpuBefore && gpuAfter ? computeGpuEngineUsage(gpuBefore, gpuAfter) : { available: false, reason: 'no GPU engine sampler', adapters: [] };
  const totalBusy = computeBusyFraction(ticksBefore, ticksAfter);
  const logical = ticksAfter.logicalProcessors;
  const foreignDuring = totalBusy !== null && jobCpu.busyLogicalProcessors !== null && logical
    ? Math.max(0, totalBusy - (jobCpu.busyLogicalProcessors / logical))
    : null;
  const usedLuid = selectUsedAdapterLuid(gpuUsage, browser.gpuAdapterSelection);
  const usedAdapter = gpuUsage.adapters?.find((adapter) => adapter.luid === usedLuid) || null;
  attempt.resources = {
    wallMs: Date.now() - startedAtMs,
    jobCpu,
    browserCommit: {
      limitBytes: profile.evidence?.enforced?.browserCommit?.bytes ?? null,
      peakJobCommitBytes: enforcementAfter?.totals?.peakJobCommitBytes ?? null,
      privateBytesAtEnd: enforcementAfter?.totals?.privateBytes ?? null,
      workingSetBytesAtEnd: enforcementAfter?.totals?.workingSetBytes ?? null,
      note: enforcementAfter?.supported
        ? 'Windows job accounting for the whole test-browser tree; the peak covers the browser lifetime so far'
        : 'unavailable without the job supervisor',
    },
    jsHeap: heap ? { usedBytes: heap.usedSize, totalBytes: heap.totalSize, source: 'Runtime.getHeapUsage (toolbar-player page)' } : null,
    gpu: {
      ...gpuUsage,
      usedAdapterLuid: usedLuid,
      jobMaxEngineUtilization: usedAdapter?.jobMaxEngineUtilization ?? null,
      foreignMaxEngineUtilization: usedAdapter?.foreignMaxEngineUtilization ?? null,
      jobDedicatedBytes: usedAdapter?.jobDedicatedBytes ?? null,
      jobSharedBytes: usedAdapter?.jobSharedBytes ?? null,
    },
  };
  const ocrFailures = attempt.documentType === 'scanned-pdf'
    ? (attempt.ocr?.applicable === true && Array.isArray(attempt.ocr.failures) ? [...attempt.ocr.failures] : ['scanned PDF OCR observation was not captured']) : [];
  ocrFailures.push(...probePdfOcrAdapterFailures(attempt.ocr, browser.gpuAdapterSelection, profile, browser.launch));
  assertionFailures.push(...ocrFailures);
  const hostLoadDuring = {
    totalCpuBusyFraction: totalBusy,
    foreignCpuFraction: foreignDuring,
    foreignGpuUtilizationPercent: gpuUsage.available && Number.isFinite(usedAdapter?.foreignMaxEngineUtilization)
      ? Math.round(usedAdapter.foreignMaxEngineUtilization * 1000) / 10 : null,
  };
  attempt.hostLoad = { before: hostLoadBefore, during: hostLoadDuring };
  attempt.environment = assessRunEnvironment({
    profile,
    observed: {
      page: {
        deviceMemory: attempt.hardware?.chrome?.deviceMemory ?? null,
        hardwareConcurrency: attempt.hardware?.chrome?.hardwareConcurrency ?? null,
        navigatorGpu: attempt.hardware?.webgpu?.navigatorGpu ?? null,
        adapter: attempt.hardware?.webgpu?.adapterInfo || null,
      },
      enforcement: enforcementAfter?.processes?.length ? enforcementAfter : (enforcementBefore || enforcementAfter),
      injections: {
        ...Object.fromEntries(Object.entries(page?.faults?.counts || {}).map(([kind, triggered]) => [kind, { triggered }])),
        'network-offline': attempt.condition?.network === 'offline'
          ? { triggered: attempt.network?.verifiedBlocked ? 1 : 0 }
          : { notApplicable: true },
        ...(attempt.runFaults?.injections || {}),
      },
      injectionsObserved: Boolean(page?.faults),
      calibration: attempt.browser?.calibration || null,
      gpuAdapter: attempt.hardware?.webgpu?.adapterInfo || null,
    },
  });
  // Contention lanes compete with a declared load on purpose.
  attempt.schedulingMode = profile.contention ? SCHEDULING_MODES.CONTENTION : SCHEDULING_MODE;
  attempt.measurement = assessMeasurementValidity({
    schedulingMode: attempt.schedulingMode,
    lock: probeState.lock,
    hostLoad: {
      foreignCpuFraction: Number.isFinite(foreignDuring) ? maxFinite(hostLoadBefore?.foreignCpuFraction, foreignDuring) : null,
      // Pre-run NVIDIA telemetry is diagnostic; it cannot establish load on
      // this run's selected/used adapter or replace missing during-run counters.
      foreignGpuUtilizationPercent: hostLoadDuring.foreignGpuUtilizationPercent,
    },
    usesGpu: attempt.execution?.observed === 'webgpu' || attempt.ocr?.usesGpu === true,
  });
  if (ocrFailures.length) {
    attempt.measurement.contaminated = true;
    attempt.measurement.reasons.push(...ocrFailures);
  }
  if (!attempt.status) {
    if (assertionFailures.length) {
      attempt.status = RUN_STATUS.FAILED;
      attempt.error = assertionFailures.join('; ');
    } else if (attempt.outcome === 'explicit-error' && !profile.expected) {
      attempt.status = RUN_STATUS.FAILED;
      attempt.error = `explicit error: ${page?.errorNotice?.message || 'unknown'}`;
    } else {
      attempt.status = RUN_STATUS.PASSED;
    }
  }
  // A contradicted environment invalidates any result; an unverified one
  // cannot support a pass, but does not hide a failure that happened first.
  const environmentStatus = attempt.environment.status;
  if ((environmentStatus === RUN_STATUS.INVALID_ENVIRONMENT && attempt.status !== RUN_STATUS.BLOCKED)
    || (environmentStatus === 'unverified' && attempt.status === RUN_STATUS.PASSED)) {
    attempt.statusBeforeEnvironmentCheck = attempt.status;
    attempt.status = RUN_STATUS.INVALID_ENVIRONMENT;
  }
  attempt.finishedAt = new Date().toISOString();
}

export function selectUsedAdapterLuid(gpuUsage, selection) {
  // Browser-job GPU activity includes rendering and cannot identify the TTS
  // device. Only the launcher's explicit physical-adapter binding qualifies.
  return gpuUsage?.available === true && typeof selection?.counterLuid === 'string' && selection.counterLuid.trim()
    ? selection.counterLuid : null;
}

export function maxFinite(...values) {
  const finite = values.filter((value) => value !== null && value !== undefined).map(Number).filter((value) => Number.isFinite(value));
  return finite.length ? Math.max(...finite) : null;
}

export async function hashProbeDocument(documentTarget) {
  return documentTarget.contentSha256 || null;
}
