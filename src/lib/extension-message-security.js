/** Accept only Chrome-provided senders from the named top-level extension pages. */
export function isTrustedExtensionPage(sender, runtime, paths) {
  if (!runtime?.id || sender?.id !== runtime.id) return false;
  if (sender.frameId !== undefined && sender.frameId !== 0 && sender.frameId !== -1) return false;
  try {
    const base = new URL(runtime.getURL(''));
    const url = new URL(sender.url);
    const origin = `${base.protocol}//${base.host}`;
    if (base.protocol !== 'chrome-extension:' || url.protocol !== base.protocol || url.host !== base.host) return false;
    if (url.username || url.password || (sender.origin !== undefined && sender.origin !== origin)) return false;
    return (Array.isArray(paths) ? paths : [paths]).some((path) => typeof path === 'string' && url.pathname === `/${path}`);
  } catch {
    return false;
  }
}

export function isTrustedBackgroundSender(sender, runtime) {
  // Offscreen documents omit getManifest; CRX emits this exact worker loader.
  const workerPath = typeof runtime?.getManifest === 'function'
    ? runtime.getManifest()?.background?.service_worker
    : 'service-worker-loader.js';
  return isTrustedExtensionPage(sender, runtime, workerPath);
}
