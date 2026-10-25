import { STORAGE_KEYS } from './storage-keys.js';

export const READABLE_TAB_TARGET_KEY = STORAGE_KEYS.READABLE_TAB_TARGET;

export function isBrowserInternalUrl(url = '') {
  return /^chrome:|^edge:|^about:|^chrome-extension:/.test(url);
}

export function isUnsupportedReadableTab(tab = {}, { isLikelyPdfTab = () => false } = {}) {
  const url = tab.url || '';
  if (/^chrome:|^edge:|^about:/.test(url)) return true;
  return /^chrome-extension:/.test(url) && !isLikelyPdfTab(tab);
}

export function createReadableTabSnapshot(tab = {}) {
  const id = Number(tab?.id);
  if (!Number.isInteger(id) || id < 0) return null;

  const snapshot = { id };
  for (const field of ['title', 'url', 'pendingUrl']) {
    const value = String(tab?.[field] || '').trim();
    if (value) snapshot[field] = value;
  }

  return Object.keys(snapshot).length > 1 ? snapshot : null;
}

export async function resolveReadableTabTarget({
  queuedTab = null,
  cachedTab = null,
  queryActiveTab,
  getTabById,
  isLikelyPdfTab = () => false,
} = {}) {
  // Explicit activations need the same extension-UI fallback as an active-tab query.
  const activeTab = await hydrateTab(queuedTab?.id ? queuedTab : await queryActiveTab?.(), getTabById);
  if (!activeTab?.id) throw new Error('No active tab found.');

  const tab = shouldUseCachedTab(cachedTab, activeTab)
    ? await hydrateTab(cachedTab, getTabById)
    : activeTab;
  if (isUnsupportedReadableTab(tab, { isLikelyPdfTab })) {
    throw new Error('Open a normal web page or PDF first.');
  }
  return tab;
}

export async function saveReadableTabTarget({ storage, tabId, tab = null, now = Date.now } = {}) {
  const tabSnapshot = createReadableTabSnapshot(tab);
  await storage.set({
    [READABLE_TAB_TARGET_KEY]: {
      tabId: tabId ?? tabSnapshot?.id ?? null,
      ...(tabSnapshot ? { tabSnapshot } : {}),
      createdAt: typeof now === 'function' ? now() : now,
    },
  });
}

export function getReadableTabTargetFromStorageValue(target = {}) {
  if (target?.tabSnapshot?.id) return target.tabSnapshot;
  return target?.tabId != null ? { id: target.tabId } : null;
}

async function hydrateTab(tab, getTabById) {
  if (!tab?.id || hasTabUrlData(tab) || typeof getTabById !== 'function') return tab;

  try {
    return { ...tab, ...(await getTabById(tab.id)) };
  } catch {
    return tab;
  }
}

function shouldUseCachedTab(cachedTab, activeTab) {
  if (!hasTabUrlData(cachedTab)) return false;
  if (cachedTab?.id === activeTab?.id && !hasTabUrlData(activeTab)) return true;
  return isPageNarratorExtensionPage(activeTab);
}

function isPageNarratorExtensionPage(tab = {}) {
  const url = String(tab?.url || tab?.pendingUrl || '');
  return /^chrome-extension:\/\/[^/]+\/src\/(?:reader-engine|popup)\.html(?:[?#].*)?$/i.test(url);
}

function hasTabUrlData(tab = {}) {
  if (!tab) return false;
  return Boolean(String(tab.url || tab.pendingUrl || '').trim());
}
