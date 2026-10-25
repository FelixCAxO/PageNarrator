import { createLogger } from './logger.js';

const HOST_PERMISSION_ERROR_PATTERNS = [
  /cannot access contents of (the )?page/i,
  /extension manifest must request permission/i,
  /missing host permission/i,
  /cannot be scripted/i,
];

export const HIDDEN_TAB_URL_ACCESS_ERROR_CODE = 'PAGENARRATOR_TAB_URL_HIDDEN';
const contentScriptInjectionLogger = createLogger('content-script-injection');

export function isContentScriptAccessError(error) {
  const message = String(error?.message || error || '');
  return HOST_PERMISSION_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function getHostPermissionOrigin(url = '') {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return `${parsed.origin}/*`;
  if (parsed.protocol === 'file:') return 'file:///*';
  return null;
}

function getHostPermissionOrigins(tab = {}) {
  const origin = getHostPermissionOrigin(tab.url || tab.pendingUrl || '');
  return origin ? [origin] : [];
}

export function isContentScriptInjectableUrl(url = '') {
  const origin = getHostPermissionOrigin(url);
  return Boolean(origin);
}

export async function requestContentScriptAccess({
  tab,
  permissions = globalThis.chrome?.permissions,
} = {}) {
  const origins = getHostPermissionOrigins(tab);
  if (!origins.length || typeof permissions?.request !== 'function') return false;
  return Boolean(await permissions.request({ origins }).catch((error) => {
    contentScriptInjectionLogger.warn('Host permission request failed.', error);
    return false;
  }));
}

export async function injectContentScript({
  tab,
  scripting,
  getContentScriptFile,
  permissions = globalThis.chrome?.permissions,
} = {}) {
  if (!tab?.id) throw new Error('No active tab found.');
  const files = [getContentScriptFile()];
  const target = { tabId: tab.id };

  try {
    await scripting.executeScript({ target, files });
  } catch (error) {
    if (!isContentScriptAccessError(error)) throw error;
    const granted = await requestContentScriptAccess({ tab, permissions });
    if (!granted) throw createContentScriptAccessError(tab, error);
    await scripting.executeScript({ target, files });
  }
}

export function createContentScriptAccessError(tab, cause) {
  const url = tab?.url || tab?.pendingUrl || '';
  if (isFileUrl(url) || isFileAccessError(cause)) {
    const error = new Error('PageNarrator needs access to local files before it can read this page. Open PageNarrator details in chrome://extensions and enable "Allow access to file URLs".');
    error.code = 'host_permission_required';
    return error;
  }

  const hostname = getReadableHostname(url);
  if (hostname) {
    const error = new Error(`Click the PageNarrator extension icon while ${hostname} is active, then choose Read page. Chrome only gives PageNarrator page access after that extension action.`);
    error.code = 'host_permission_required';
    return error;
  }

  const error = new Error('Click the PageNarrator extension icon while the page you want to read is active, then choose Read page. Chrome only gives PageNarrator page access after that extension action.');
  error.code = HIDDEN_TAB_URL_ACCESS_ERROR_CODE;
  return error;
}

function isFileAccessError(error) {
  return /\bfile:\/\//i.test(String(error?.message || error || ''));
}

function isFileUrl(url = '') {
  try {
    return new URL(url).protocol === 'file:';
  } catch {
    return false;
  }
}

function getReadableHostname(url = '') {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
