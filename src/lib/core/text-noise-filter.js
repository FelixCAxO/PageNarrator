const PRIVATE_USE_CHARACTER_PATTERN = /[\uE000-\uF8FF]/gu;
const LINGUISTIC_CONTENT_PATTERN = /[\p{L}\p{N}]/u;
const ICON_CLASS_PATTERN = /(^|[\s_-])(icon|icons|fa|fas|far|fab|fal|material-icons|material-symbols(?:-[a-z0-9-]+)?)([\s_-]|$)/i;
const SHARE_WIDGET_LABEL_PATTERN = /^(copy link|email|email this(?: article| story)?|facebook|linkedin|mail|mastodon|post(?: to .+)?|reddit|share|share (?:by|on|to|via) .+|share this(?: article| story)?|(?:clap|like)(?: (?:this )?(?:article|story)| button for (?:article|story) likes)?|telegram|threads|tweet|tweet this(?: article| story)?|twitter|whatsapp|x)$/i;
const REFERENCE_CLASS_PATTERN = /(^|[\s_-])(?:noteref|footnote(?:-ref)?|citation|cite(?:[-_]ref)?)([\s_-]|$)/i;
const REFERENCE_ROLE_PATTERN = /^(doc-noteref|doc-biblioref)$/i;
const REFERENCE_HREF_PATTERN = /^#.*(?:cite|citation|ref|reference|note|footnote|endnote|source|fn)/i;
const SHORT_REFERENCE_LABEL_PATTERN = /^(?:\[\s*)?[\p{L}\p{N}]{1,4}(?:\s*(?:,|-|\u2013|\u2014)\s*[\p{L}\p{N}]{1,4}){0,3}(?:\s*\])?$/u;

export function stripPrivateUseCharacters(value) {
  return String(value || '').replace(PRIVATE_USE_CHARACTER_PATTERN, '');
}

export function isSpeakableSourceText(text) {
  const value = stripPrivateUseCharacters(String(text || '')).trim();
  return Boolean(value && LINGUISTIC_CONTENT_PATTERN.test(value));
}

export function isTextlessIconElement(element) {
  if (!element?.matches) return false;
  const tagName = element.localName?.toLowerCase();
  if (tagName === 'svg') return true;
  return ICON_CLASS_PATTERN.test(String(element.getAttribute('class') || ''));
}

export function isReferenceTextElement(element) {
  if (!element?.matches) return false;
  const tagName = element.localName?.toLowerCase();
  const role = String(element.getAttribute('role') || '').toLowerCase();
  const hasReferenceClass = REFERENCE_CLASS_PATTERN.test(String(element.getAttribute('class') || ''));
  if (REFERENCE_ROLE_PATTERN.test(role)) return true;
  const genericReferenceMarker = (tagName === 'a' || tagName === 'span' || tagName === 'sup') && element.classList?.contains('reference');
  const href = String(element.getAttribute('href') || '');
  if (!hasReferenceClass && !genericReferenceMarker && (tagName !== 'a' || !href.startsWith('#'))) return false;
  const text = stripPrivateUseCharacters(String(element.textContent || '')).replace(/\s+/g, ' ').trim();
  if (hasReferenceClass && isShortReferenceLabel(text)) return true;
  if (genericReferenceMarker && (tagName === 'sup' || /^\[\s*\d/u.test(text)) && isShortReferenceLabel(text)) return true;
  if (tagName !== 'a' || !isShortReferenceLabel(text)) return false;

  if (!href.startsWith('#')) return false;
  return REFERENCE_HREF_PATTERN.test(href)
    || hasElevatedPresentation(element)
    || element.closest?.('sup');
}

export function isNavigationHeadingElement(element) {
  if (!element?.id || !element.matches?.('h1, h2, h3, h4, h5, h6, [role="heading"]')) return false;
  const navigation = element.nextElementSibling;
  return Boolean(navigation?.matches('nav, [role="navigation"]')
    && (navigation.getAttribute('aria-labelledby') || '').split(/\s+/u).includes(element.id));
}

export function isShareWidgetLabel(text) {
  return SHARE_WIDGET_LABEL_PATTERN.test(String(text || '').trim());
}

function isShortReferenceLabel(text) {
  return SHORT_REFERENCE_LABEL_PATTERN.test(String(text || '').trim());
}

function hasElevatedPresentation(element) {
  const styleAttr = String(element.getAttribute?.('style') || '').toLowerCase();
  if (/\bvertical-align\s*:\s*(?:super|text-top)\b/.test(styleAttr)) return true;

  const style = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
  return /^(super|text-top)$/i.test(String(style?.verticalAlign || ''));
}
