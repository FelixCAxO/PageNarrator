import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { summarizeProbeBudgetFailures, summarizeTtsProbeRuns } from './live-tts-hardware-profiles.js';

import { computeLaneVerdict, isPassingLaneVerdict } from './tts-probe-observations.js';
import { getProbeCleanupFailures } from './live-tts-hardware-probe-assertions.js';

import { RUN_STATUS } from '../../scripts/weak-hardware/evidence-contract.mjs';

import { ensureMeasurementLock } from '../../scripts/weak-hardware/measurement-lock.mjs';

import { RUN_TTS_PROBE, RUN_ID, PROBE_PROFILE_SELECTION, SCHEDULING_MODE, probeState, PROBE_PROFILES, PROBE_DOCUMENT_TYPES, getRequiredProbeSections, ROOT_DIR, PROBE_TEST_TIMEOUT_MS } from './tts-probe-settings.js';
import { prepareRunContext } from './tts-probe-environment.js';
import { runProbeProfile } from './tts-probe-runner.js';
import { writeProbeOutput } from './tts-probe-results.js';

describe.skipIf(!RUN_TTS_PROBE)('live Chrome TTS hardware probe', () => {
  let lock;
  let runContext;
  const extensionCopyRoot = {};

  beforeAll(async () => {
    lock = await ensureMeasurementLock({
      owner: { purpose: 'tts-hardware-probe', runId: RUN_ID, profiles: PROBE_PROFILE_SELECTION || 'host', mode: SCHEDULING_MODE },
      onWait: (holder) => console.warn(`Waiting for the host measurement lock held by ${holder?.purpose || 'another run'} ${holder?.runId || ''}`),
    });
    probeState.lock = { held: lock.held, inherited: lock.inherited };
    runContext = await prepareRunContext(lock);
  }, 4 * 60 * 60 * 1000);

  afterAll(() => {
    lock?.release?.();
  });

  it('records backend selection and first TTS timing for the selected browser hardware profiles', async () => {
    const attempts = [];
    const budgetFailures = [];
    for (const profile of PROBE_PROFILES) {
      const { profileOutputs } = await runProbeProfile({ profile, runContext, attempts, extensionCopyRoot });
      for (const documentType of PROBE_DOCUMENT_TYPES) {
        const documentAttempts = attempts.filter((attempt) => attempt.profile?.name === profile.name && attempt.documentType === documentType);
        if (!documentAttempts.length) continue;
        const summary = summarizeTtsProbeRuns(profileOutputs.filter((output) => output.documentType === documentType));
        summary.contaminatedRuns = documentAttempts.filter((attempt) => attempt.measurement?.contaminated).length;
        budgetFailures.push(...summarizeProbeBudgetFailures({
          ...profile,
          minProbeSections: getRequiredProbeSections(profile, documentType),
        }, summary));
      }
    }
    runContext.run.extension.preparedSha256 = extensionCopyRoot.preparedSha256 || null;
    const lanes = PROBE_PROFILES.map((profile) => computeLaneVerdict(profile, attempts));
    await writeProbeOutput(runContext, attempts, lanes);
    console.log(JSON.stringify({
      output: path.relative(ROOT_DIR, runContext.outputPath),
      lanes,
      attempts: attempts.map((attempt) => ({
        profile: attempt.profile?.name,
        document: attempt.documentType,
        run: attempt.runIndex,
        status: attempt.status,
        outcome: attempt.outcome,
        execution: attempt.execution?.observed ?? null,
        contaminated: attempt.measurement?.contaminated ?? null,
        error: attempt.error,
      })),
    }, null, 2));

    const cleanupFailures = getProbeCleanupFailures(attempts);
    const legacyFailures = attempts
      .filter((attempt) => !attempt.profile?.expected && attempt.status !== RUN_STATUS.PASSED)
      .map((attempt) => `${attempt.profile?.name} ${attempt.documentType} #${attempt.runIndex}: ${attempt.status} ${attempt.error || ''}`);
    const laneFailures = lanes.filter((lane) => (
      PROBE_PROFILES.find((profile) => profile.name === lane.profileName)?.expected && !isPassingLaneVerdict(lane.verdict)
    ));
    expect({ legacyFailures, laneFailures, budgetFailures, cleanupFailures }).toEqual({ legacyFailures: [], laneFailures: [], budgetFailures: [], cleanupFailures: [] });
  }, PROBE_TEST_TIMEOUT_MS);
});
