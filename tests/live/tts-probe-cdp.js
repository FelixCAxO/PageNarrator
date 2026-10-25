import { setTimeout as delay } from 'node:timers/promises';

import { PAGE_BLOCKED_BOUND_MS } from './tts-probe-observations.js';

import { waitFor } from './tts-probe-settings.js';

// Page evaluations are short; one that does not return means the page's
// renderer is unresponsive (e.g. stuck under a memory ceiling) or busy. Pages
// registered in BUSY_PAGE_WAITS are waited on while job CPU keeps rising.
export const PAGE_EVALUATE_TIMEOUT_MS = PAGE_BLOCKED_BOUND_MS;

export const BUSY_PAGE_WAITS = new Map();

export async function evaluateExpression(cdp, sessionId, expression, options = {}) {
  for (;;) {
    const sentAtMs = Date.now();
    try {
      const result = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        ...options,
      }, sessionId, { timeoutMs: PAGE_EVALUATE_TIMEOUT_MS });
      BUSY_PAGE_WAITS.get(sessionId)?.answered();
      return result;
    } catch (error) {
      const busyWait = error?.name === 'CdpTimeoutError' ? BUSY_PAGE_WAITS.get(sessionId) : null;
      if (!busyWait || !(await busyWait.stillBusy(sentAtMs))) throw error;
    }
  }
}

export async function attachToTarget(cdp, targetId) {
  const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, attached.sessionId);
  await cdp.send('Page.enable', {}, attached.sessionId).catch(() => null);
  // Inspector.targetCrashed identifies renderer crashes (e.g. memory ceilings).
  await cdp.send('Inspector.enable', {}, attached.sessionId).catch(() => null);
  return attached.sessionId;
}

export async function closeTargetBestEffort(cdp, targetId, timeoutMs = 2_000) {
  await Promise.race([
    cdp.send('Target.closeTarget', { targetId }).catch(() => null),
    delay(timeoutMs),
  ]);
}

export async function getExtensionId(cdp, serviceWorkerSessionId) {
  // Target discovery can precede the service worker's extension API initialization.
  return waitFor(async () => {
    const result = await evaluateExpression(cdp, serviceWorkerSessionId,
      'globalThis.chrome?.storage?.local && globalThis.chrome?.runtime?.id');
    const id = result.result.value;
    return typeof id === 'string' && /^[a-p]{32}$/.test(id) ? id : null;
  }, 'Probe service worker extension APIs did not initialize');
}

export async function getTabIdByUrl(cdp, serviceWorkerSessionId, url) {
  const result = await evaluateExpression(cdp, serviceWorkerSessionId, `
    (async () => {
      const tabs = await chrome.tabs.query({});
      const expected = new URL(${JSON.stringify(url)});
      const exact = tabs.find((tab) => tab.url === ${JSON.stringify(url)});
      if (exact?.id) return exact.id;
      if (expected.protocol === 'chrome-extension:') {
        const viewerTab = tabs.find((tab) => {
          if (!tab.url) return false;
          const candidate = new URL(tab.url);
          return candidate.origin === expected.origin && candidate.pathname === expected.pathname;
        });
        if (viewerTab?.id) return viewerTab.id;
        return tabs.find((tab) => tab.active)?.id || null;
      }
      return null;
    })()
  `);
  return result.result.value;
}
