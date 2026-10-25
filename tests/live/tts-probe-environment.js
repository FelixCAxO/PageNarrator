import os from 'node:os';
import path from 'node:path';

import { PROBE_HARNESS_ADAPTER_OPTION } from './tts-probe-page-hooks.js';

import { MODEL_ID, MODEL_REVISION } from '../../src/lib/voice-model.js';

import { isJobSupervisorSupported, startJobSupervisor } from '../../scripts/weak-hardware/windows-job.mjs';
import { PHYSICAL_TARGET_ENV, loadPhysicalTarget, readHostInventory } from '../../scripts/weak-hardware/physical-target.mjs';

import { hashDirectory, resolveRevision, resolveRunOutputDir } from '../../scripts/weak-hardware/run-provenance.mjs';
import { evaluateExpression } from './tts-probe-cdp.js';
import { ROOT_DIR, DIST_DIR, RUN_ID, sanitizePathPart, PROBE_PROFILE_SELECTION, SCHEDULING_MODE, PROBE_DOCUMENT_TYPES, PREPARED_EXTENSION_MODIFICATIONS, NATIVE_BACKGROUNDING } from './tts-probe-settings.js';

export async function collectHardwareSnapshot(cdp, sessionId) {
  const result = await evaluateExpression(cdp, sessionId, `
    (async () => {
      const platform = String(navigator.userAgentData?.platform || navigator.platform || '');
      // The harness marker keeps this observation out of fault-injection trigger counts.
      const adapterOptions = {
        ...(/^win/i.test(platform) ? {} : { powerPreference: 'high-performance' }),
        ${JSON.stringify(PROBE_HARNESS_ADAPTER_OPTION)}: true,
      };
      const adapter = await navigator.gpu?.requestAdapter?.(adapterOptions).catch(() => null);
      let adapterInfo = null;
      if (adapter?.info) {
        adapterInfo = {
          vendor: adapter.info.vendor || '',
          architecture: adapter.info.architecture || '',
          device: adapter.info.device || '',
          description: adapter.info.description || '',
        };
      } else if (adapter?.requestAdapterInfo) {
        adapterInfo = await adapter.requestAdapterInfo().catch(() => null);
      }
      return {
        chrome: {
          deviceMemory: Number.isFinite(Number(navigator.deviceMemory)) ? Number(navigator.deviceMemory) : null,
          hardwareConcurrency: Number.isFinite(Number(navigator.hardwareConcurrency)) ? Number(navigator.hardwareConcurrency) : null,
        },
        webgpu: {
          navigatorGpu: Boolean(navigator.gpu),
          available: Boolean(adapter),
          adapterInfo,
          limits: adapter ? {
            maxStorageBufferBindingSize: Number.isFinite(Number(adapter.limits?.maxStorageBufferBindingSize)) ? Number(adapter.limits.maxStorageBufferBindingSize) : null,
            maxBufferSize: Number.isFinite(Number(adapter.limits?.maxBufferSize)) ? Number(adapter.limits.maxBufferSize) : null,
          } : null,
        },
      };
    })()
  `);
  const browserHardware = result.result.value;
  return {
    host: collectHostSnapshot(),
    ...browserHardware,
    derived: {
      vramProxyMb: deriveVramProxyMb(browserHardware?.webgpu),
    },
  };
}

export function collectHostSnapshot() {
  const cpus = os.cpus() || [];
  return {
    os: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
    },
    cpu: {
      model: cpus[0]?.model || null,
      logicalCores: cpus.length || null,
    },
    memory: {
      totalRamBytes: os.totalmem(),
      freeRamBytes: os.freemem(),
    },
    process: process.memoryUsage(),
  };
}

export function deriveVramProxyMb(webgpu = {}) {
  const limits = webgpu?.limits || {};
  const values = [
    limits.maxStorageBufferBindingSize,
    limits.maxBufferSize,
  ].filter((value) => Number.isFinite(Number(value))).map(Number);
  return values.length ? Math.floor(Math.min(...values) / (1024 * 1024)) : null;
}

export function describeProbeProfile(profile) {
  return {
    name: profile.name,
    label: profile.label,
    simulated: profile.simulated,
    navigator: profile.navigator,
    disableWebGpu: profile.disableWebGpu,
    gpu: profile.gpu,
    playbackSettings: profile.playbackSettings,
    requirement: profile.requirement,
    minProbeSections: profile.minProbeSections || null,
    expectBrowserFallback: Boolean(profile.expectBrowserFallback),
    forceKokoroFailure: Boolean(profile.forceKokoroFailure),
    coldStart: Boolean(profile.coldStart),
    lane: profile.lane || null,
    evidence: profile.evidence || null,
    faults: profile.faults || [],
    expected: profile.expected || null,
    expectedWasmThreads: profile.expectedWasmThreads ?? null,
  };
}

// Physical, non-software adapters as DXGI reports them (Windows only).
export async function readHostGpuNames() {
  if (!isJobSupervisorSupported()) return undefined;
  const supervisor = await startJobSupervisor();
  try {
    return (await supervisor.adapters()).adapters.filter((adapter) => !adapter.software).map((adapter) => adapter.description);
  } finally {
    await supervisor.terminate();
  }
}

export async function prepareRunContext(lock) {
  const revision = resolveRevision({ root: ROOT_DIR });
  const extension = await hashDirectory(DIST_DIR);
  const runDir = resolveRunOutputDir({ root: ROOT_DIR, revision, runId: RUN_ID });
  const outputPath = process.env.PAGENARRATOR_TTS_PROBE_OUTPUT
    || path.join(runDir, `tts-hardware-probe-${sanitizePathPart(PROBE_PROFILE_SELECTION || 'host')}.json`);
  // Only an attestation that matches this host's own inventory makes the run
  // physical-target evidence; a mismatch stops the run before it starts.
  const physicalTarget = process.env[PHYSICAL_TARGET_ENV]
    ? loadPhysicalTarget({ host: { ...readHostInventory(), gpus: await readHostGpuNames() } })
    : null;
  return {
    outputPath,
    run: {
      physicalTarget,
      runId: RUN_ID,
      startedAt: new Date().toISOString(),
      schedulingMode: SCHEDULING_MODE,
      profileSelection: PROBE_PROFILE_SELECTION || 'host',
      documentTypes: PROBE_DOCUMENT_TYPES,
      revision,
      extension: {
        directory: path.relative(ROOT_DIR, DIST_DIR) || '.',
        sha256: extension.sha256,
        fileCount: extension.fileCount,
        bytes: extension.bytes,
        modifications: PREPARED_EXTENSION_MODIFICATIONS,
      },
      model: { id: MODEL_ID, revision: MODEL_REVISION, voice: 'af_heart' },
      lock: {
        held: lock.held === true,
        inherited: lock.inherited === true,
        waitedMs: lock.waitedMs ?? null,
        lockPath: lock.lockPath,
      },
      host: collectHostSnapshot(),
      nativeBackgrounding: NATIVE_BACKGROUNDING,
      instrumentation: [
        'pagenarratorTtsHardwareProbe storage flag enables the toolbar-player probe recorder',
        'page hooks: navigator overrides, fault injection counters and a media-element audio tap',
      ],
    },
  };
}
