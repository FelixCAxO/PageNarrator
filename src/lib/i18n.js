export function getMessage(key, substitutions = undefined, {
  i18n = globalThis.chrome?.i18n,
  fallback = '',
} = {}) {
  const value = typeof i18n?.getMessage === 'function'
    ? i18n.getMessage(key, substitutions)
    : '';
  return value || fallback;
}

export function localizeDocument(root = globalThis.document, options = {}) {
  if (!root?.querySelectorAll) return;
  for (const element of root.querySelectorAll('[data-i18n]')) {
    const key = element.getAttribute('data-i18n');
    const message = getMessage(key, undefined, {
      ...options,
      fallback: element.textContent,
    });
    if (message) element.textContent = message;
  }
}
