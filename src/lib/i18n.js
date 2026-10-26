export function getMessage(key, substitutions = undefined, {
  i18n = globalThis.chrome?.i18n,
  fallback = '',
} = {}) {
  const value = typeof i18n?.getMessage === 'function'
    ? i18n.getMessage(key, substitutions)
    : '';
  return value || fallback;
}

// Stable keys keep the English copy beside its call site and avoid a runtime lookup table.
export function messageKey(source) {
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) hash = Math.imul(hash ^ source.charCodeAt(index), 16777619);
  return `ui_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function t(source, substitutions = [], options = {}) {
  if (!source) return source || '';
  const values = Array.isArray(substitutions) ? substitutions.map(String) : [String(substitutions)];
  const fallback = source.replace(/\$(\d+)/gu, (token, index) => values[Number(index) - 1] ?? token);
  return getMessage(messageKey(source), values, { ...options, fallback });
}

export function languageName(code, fallback = code, locale = globalThis.chrome?.i18n?.getUILanguage?.() || 'en') {
  try { return new Intl.DisplayNames([locale.replaceAll('_', '-')], { type: 'language' }).of(code) || fallback; }
  catch { return fallback; }
}

export function localizeDocument(root = globalThis.document, options = {}) {
  if (!root?.querySelectorAll) return;
  const i18n = options.i18n || globalThis.chrome?.i18n;
  if (root.documentElement) {
    root.documentElement.lang = i18n?.getUILanguage?.() || 'en';
    root.documentElement.dir = i18n?.getMessage?.('@@bidi_dir') || 'ltr';
  }
  for (const element of root.querySelectorAll('[data-i18n]')) {
    const key = element.getAttribute('data-i18n');
    const message = getMessage(key, undefined, {
      ...options,
      fallback: element.textContent,
    });
    if (message) element.textContent = message;
  }
  for (const attribute of ['title', 'aria-label', 'placeholder', 'alt', 'data-label']) {
    for (const element of root.querySelectorAll(`[data-i18n-${attribute}]`)) {
      const message = getMessage(element.getAttribute(`data-i18n-${attribute}`), undefined, {
        ...options, fallback: element.getAttribute(attribute),
      });
      if (message) element.setAttribute(attribute, message);
    }
  }
}
