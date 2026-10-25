import { expect } from 'vitest';

import { createProbePageHooksSource } from './tts-probe-page-hooks.js';

import { getResumePositionStorageKey } from '../../src/lib/storage-keys.js';

import { attachToTarget, evaluateExpression } from './tts-probe-cdp.js';
import { waitFor, PROBE_TIMEOUT_MS, TTS_HARDWARE_PROBE_STORAGE_KEY, READABLE_TAB_TARGET_KEY, PLAYBACK_SETTINGS_KEY, TEST_HOOKS_KEY, TEST_FORCE_KOKORO_FAILURE_KEY, getProbeSpeed } from './tts-probe-settings.js';
import { describeProbeProfile } from './tts-probe-environment.js';

// Overrides, fault injections and the audio tap are installed before any
// toolbar-player script runs (see tts-probe-page-hooks.js).
export function createNavigatorOverrideSource(profile) {
  return createProbePageHooksSource(profile, { audioTap: true });
}

export async function openReaderEngineTargetForProfile(cdp, extensionId, profile, { workers = null, offline = false } = {}) {
  // Register this hardware-overridden engine with the production message host.
  const readerEngineUrl = `chrome-extension://${extensionId}/src/reader-engine.html?engine=1`;
  const overrideSource = createNavigatorOverrideSource(profile);
  const created = await cdp.send('Target.createTarget', { url: overrideSource ? 'about:blank' : readerEngineUrl });
  await cdp.send('Target.activateTarget', { targetId: created.targetId }).catch(() => null);
  const sessionId = await attachToTarget(cdp, created.targetId);
  // Auto-attach records the dedicated workers (ONNX Runtime pthreads) this page starts.
  workers?.set(sessionId, []);
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId).catch(() => null);
  if (offline) {
    // Offline before the page loads, so every model request from this context is blocked.
    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessionId);
  }
  if (overrideSource) {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: overrideSource }, sessionId);
    await cdp.send('Page.navigate', { url: readerEngineUrl }, sessionId);
  }
  await waitForReaderEngineExtensionContext(cdp, sessionId, readerEngineUrl, profile);
  await cdp.send('Target.activateTarget', { targetId: created.targetId }).catch(() => null);
  return {
    targetId: created.targetId,
    sessionId,
  };
}

export async function waitForReaderEngineExtensionContext(cdp, sessionId, readerEngineUrl, profile) {
  let lastContextState = null;
  await waitFor(async () => {
    try {
      const result = await evaluateExpression(cdp, sessionId, `(() => ({
        url: location.href,
        hasStorage: Boolean(globalThis.chrome?.storage?.local),
      }))()`);
      if (result.exceptionDetails) {
        lastContextState = {
          exception: result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Runtime.evaluate failed',
        };
        return false;
      }
      const value = result.result.value;
      lastContextState = value;
      return value?.url === readerEngineUrl && value?.hasStorage;
    } catch (error) {
      lastContextState = { error: error?.message || String(error) };
      return false;
    }
  }, () => `Toolbar player extension context did not load for ${profile.name}: ${JSON.stringify(lastContextState)}`, 30_000);
}

export async function waitForProbeReadCleanup(cdp, sessionId, popupSessionId) {
  const stopState = await evaluateExpression(cdp, popupSessionId, `(() => {
    const button = document.getElementById('popup-stop');
    return Boolean(button && !button.disabled && button.getClientRects().length);
  })()`);
  if (stopState.result.value) await clickProbePopupControl(cdp, popupSessionId, 'popup-stop');

  await waitFor(async () => {
    const result = await evaluateExpression(cdp, sessionId, `(() => ({
      status: document.getElementById('status-label')?.textContent || '',
      readDisabled: Boolean(document.getElementById('read-btn')?.disabled),
      stopHidden: Boolean(document.getElementById('stop-btn')?.hidden),
    }))()`);
    const value = result.result.value;
    return value.stopHidden
      && value.readDisabled === false
      && !value.status.includes('Stopping');
  }, 'Probe read did not settle before closing its toolbar player target', PROBE_TIMEOUT_MS);
}

export async function configureProbeRead(cdp, extensionPageSessionId, documentTarget, profile, condition = {}) {
  const profileDescriptor = describeProbeProfile(profile);
  const backendPreference = condition.playbackSettings?.ttsBackendPreference || profile.playbackSettings?.ttsBackendPreference || 'auto';
  const performanceProfile = profile.playbackSettings?.ttsPerformanceProfile || 'auto';
  const result = await evaluateExpression(cdp, extensionPageSessionId, `
    (async () => {
      const tabSnapshot = {
        id: ${JSON.stringify(documentTarget.tabId)},
        title: ${JSON.stringify(documentTarget.title)},
        url: ${JSON.stringify(documentTarget.url)},
      };
      const createdAt = Date.now();
      await chrome.storage.local.remove([
        ${JSON.stringify(TTS_HARDWARE_PROBE_STORAGE_KEY)},
        ${JSON.stringify(READABLE_TAB_TARGET_KEY)},
        ${JSON.stringify(PLAYBACK_SETTINGS_KEY)},
        ${JSON.stringify(TEST_HOOKS_KEY)},
        ${JSON.stringify(TEST_FORCE_KOKORO_FAILURE_KEY)},
        ${JSON.stringify(getResumePositionStorageKey(documentTarget.url))},
      ]);
      await chrome.storage.local.set({
        ${JSON.stringify(TTS_HARDWARE_PROBE_STORAGE_KEY)}: {
          enabled: true,
          profile: ${JSON.stringify(profileDescriptor)},
          documentType: ${JSON.stringify(documentTarget.documentType)},
        },
        ${JSON.stringify(READABLE_TAB_TARGET_KEY)}: {
          tabId: tabSnapshot.id,
          tabSnapshot,
          createdAt,
        },
        ${JSON.stringify(PLAYBACK_SETTINGS_KEY)}: {
          language: 'en',
          voice: 'af_heart',
          speed: ${JSON.stringify(getProbeSpeed(profile))},
          sectionPauseSeconds: 0,
          ttsPerformanceProfile: ${JSON.stringify(performanceProfile)},
          ttsBackendPreference: ${JSON.stringify(backendPreference)},
          voicesByLanguage: { en: 'af_heart' },
        },
        ${JSON.stringify(TEST_HOOKS_KEY)}: ${JSON.stringify(Boolean(profile.forceKokoroFailure))},
        ${JSON.stringify(TEST_FORCE_KOKORO_FAILURE_KEY)}: ${JSON.stringify(Boolean(profile.forceKokoroFailure))},
      });
      return tabSnapshot;
    })()
  `);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Could not configure probe read');
  }
  return result.result.value;
}

export async function openProbePopup(cdp, extensionId) {
  const { targetId } = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/src/popup.html`,
  });
  const sessionId = await attachToTarget(cdp, targetId);
  await cdp.send('Target.activateTarget', { targetId });
  return { targetId, sessionId };
}

// The popup reveals cards (e.g. "Prepare local voice") asynchronously above its
// buttons, so a point measured once can land on other content by the time the
// click arrives. Click only once the button's position has been stable for one
// poll and a hit test at that point returns the button itself.
export async function clickProbePopupControl(cdp, sessionId, buttonId) {
  let previous = null;
  let polls = 0;
  const point = await waitFor(async () => {
    polls += 1;
    const result = await evaluateExpression(cdp, sessionId, `(() => {
      const button = document.getElementById(${JSON.stringify(buttonId)});
      if (!button || button.disabled || !button.getClientRects().length) return null;
      button.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const rect = button.getBoundingClientRect();
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, hitsButton: Boolean(hit && (hit === button || button.contains(hit))) };
    })()`);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    const current = result.result.value;
    const stable = current && previous && current.x === previous.x && current.y === previous.y;
    previous = current;
    return stable && current.hitsButton ? current : null;
  }, `Popup control ${buttonId} did not become available at a stable, unobstructed position`, 30_000);
  // CDP native input passes the same trusted-event boundary as a user click.
  const clickedAtEpochMs = Date.now();
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 }, sessionId);
  return { x: point.x, y: point.y, hitTestVerified: true, polls, clickedAtEpochMs };
}

export async function queueProbeReadAction(cdp, popupSessionId) {
  return clickProbePopupControl(cdp, popupSessionId, 'start-reading');
}

export async function seedProbeDocumentTarget(cdp, serviceWorkerSessionId, documentTarget) {
  await cdp.send('Target.activateTarget', { targetId: documentTarget.targetId });
  const result = await evaluateExpression(cdp, serviceWorkerSessionId, `
    (async () => {
      const tabSnapshot = {
        id: ${JSON.stringify(documentTarget.tabId)},
        title: ${JSON.stringify(documentTarget.title)},
        url: ${JSON.stringify(documentTarget.url)},
      };
      await chrome.tabs.update(tabSnapshot.id, { active: true });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await chrome.storage.local.set({
        ${JSON.stringify(READABLE_TAB_TARGET_KEY)}: {
          tabId: tabSnapshot.id,
          tabSnapshot,
          createdAt: Date.now(),
        },
      });
      return true;
    })()
  `);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Could not seed probe document');
  }
}

export async function expectRuntimeControlsHidden(cdp, sessionId) {
  const result = await evaluateExpression(cdp, sessionId, `(() => ({
    profile: Boolean(document.getElementById('tts-performance-profile-select')),
    backend: Boolean(document.getElementById('tts-backend-preference-select')),
    idleRelease: Boolean(document.getElementById('idle-release-enabled')),
  }))()`);
  expect(result.result.value).toEqual({
    profile: false,
    backend: false,
    idleRelease: false,
  });
}
