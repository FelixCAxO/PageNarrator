import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { statusForError } from './tts-probe-observations.js';
import { needsFreshDocumentTarget } from './tts-probe-workloads.js';

import { RUN_STATUS } from '../../scripts/weak-hardware/evidence-contract.mjs';

import { sampleHostLoad, sampleTopProcesses } from '../../scripts/weak-hardware/host-load.mjs';

import { hashDirectory } from '../../scripts/weak-hardware/run-provenance.mjs';
import { prepareProbeExtension, reopenProbePdfDocument } from './tts-probe-document-targets.js';
import { startProbeBrowserSession, stopProbeBrowserSession } from './tts-probe-browser-session.js';
import { createAttemptRecord, writeProbeOutput } from './tts-probe-results.js';
import { PROBE_DOCUMENT_TYPES, getProfileDocumentTypes, getProbeRunCount, getRequiredProbeSections, getReadsPerTarget, MAX_CONSECUTIVE_FAILURES } from './tts-probe-settings.js';
import { runProbeAttempt } from './tts-probe-attempt.js';

export async function runProbeProfile({ profile, runContext, attempts, extensionCopyRoot }) {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'pagenarrator-tts-probe-'));
  const liveExtensionDir = path.join(userDataDir, 'extension');
  const hostLoadBefore = await sampleHostLoad({ windowMs: 3000, topProcesses: sampleTopProcesses });
  const profileOutputs = [];
  let session = null;
  const cleanups = [];
  try {
    await prepareProbeExtension(liveExtensionDir);
    extensionCopyRoot.preparedSha256 ||= (await hashDirectory(liveExtensionDir)).sha256;
    try {
      session = await startProbeBrowserSession({ profile, userDataDir, liveExtensionDir });
    } catch (error) {
      const attempt = createAttemptRecord({ profile, documentTarget: { documentType: PROBE_DOCUMENT_TYPES[0] }, runIndex: 0, runCount: 0 });
      attempts.push({
        ...attempt,
        status: statusForError(error),
        error: error.message,
        hostLoad: { before: hostLoadBefore },
        finishedAt: new Date().toISOString(),
      });
      return { profileOutputs };
    }

    documents: for (const documentType of getProfileDocumentTypes(profile)) {
      const runCount = getProbeRunCount(profile, documentType);
      const requiredSections = getRequiredProbeSections(profile, documentType);
      let consecutiveFailures = 0;
      for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
        const condition = getRunCondition(profile, runIndex);
        if (condition.restartBrowser) {
          // Same private profile: Cache Storage and settings survive the restart.
          cleanups.push(await stopProbeBrowserSession(session));
          session = null;
          try {
            session = await startProbeBrowserSession({ profile, userDataDir, liveExtensionDir });
          } catch (error) {
            attempts.push({
              ...createAttemptRecord({ profile, documentTarget: { documentType }, runIndex, runCount }),
              condition,
              status: statusForError(error),
              error: `browser restart failed: ${error.message}`,
              finishedAt: new Date().toISOString(),
            });
            await writeProbeOutput(runContext, attempts);
            break documents;
          }
        }
        if (needsFreshDocumentTarget(documentType, { usedInSession: session.usedDocumentTypes.has(documentType) })) {
          try {
            await reopenProbePdfDocument(session, documentType);
          } catch (error) {
            attempts.push({
              ...createAttemptRecord({ profile, documentTarget: { documentType }, runIndex, runCount }),
              condition,
              status: statusForError(error),
              error: `PDF viewer reopen failed: ${error.message}`,
              finishedAt: new Date().toISOString(),
            });
            await writeProbeOutput(runContext, attempts);
            break documents;
          }
        }
        const documentTarget = session.probeDocuments.find((entry) => entry.documentType === documentType);
        const attempt = createAttemptRecord({ profile, documentTarget, runIndex, runCount });
        attempt.browser = session.browserInfo;
        attempt.condition = condition;
        attempt.status = 'running';
        attempts.push(attempt);
        // Persist the attempt before it runs: an abandoned run stays visible as "running".
        await writeProbeOutput(runContext, attempts);
        attempt.status = null;
        const result = await runProbeAttempt({
          cdp: session.cdp,
          browser: session.browser,
          profile,
          documentTarget,
          extensionId: session.extensionId,
          serviceWorkerSessionId: session.serviceWorkerSessionId,
          requiredSections,
          attempt,
          condition,
          hostLoadBefore,
          workersBySession: session.workersBySession,
          crashedSessions: session.crashedSessions,
          consoleBySession: session.consoleBySession,
          serviceWorkerSessionIdForConsole: session.serviceWorkerSessionId,
          readsPerTarget: getReadsPerTarget(documentType),
          startRepeatedAttempt: async (readIndex) => {
            const repeated = createAttemptRecord({ profile, documentTarget, runIndex, runCount });
            repeated.attemptId = `${repeated.attemptId}:read${readIndex}`;
            repeated.readIndex = readIndex;
            repeated.browser = session.browserInfo;
            repeated.condition = condition;
            repeated.status = 'running';
            attempts.push(repeated);
            await writeProbeOutput(runContext, attempts);
            repeated.status = null;
            return repeated;
          },
        });
        session.usedDocumentTypes.add(documentType);
        if (result.output) profileOutputs.push(result.output);
        consecutiveFailures = attempt.status === RUN_STATUS.PASSED ? 0 : consecutiveFailures + 1;
        await writeProbeOutput(runContext, attempts);
        if (attempt.status === RUN_STATUS.CRASHED && attempt.crash === 'browser') break;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !profile.expected?.requireConsistentOutcome) break;
      }
    }
  } finally {
    if (session) cleanups.push(await stopProbeBrowserSession(session));
    const cleanup = {
      verified: cleanups.length > 0 && cleanups.every((entry) => entry?.verified === true),
      sessions: cleanups,
    };
    for (const attempt of attempts) {
      if (attempt.profile?.name === profile.name && !attempt.cleanup) attempt.cleanup = cleanup;
    }
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => null);
  }
  return { profileOutputs };
}

export function getRunCondition(profile, runIndex) {
  const condition = profile.runConditions?.[runIndex] || { network: 'online' };
  return profile.freshBrowserPerRun && runIndex > 0 ? { ...condition, restartBrowser: true } : condition;
}
