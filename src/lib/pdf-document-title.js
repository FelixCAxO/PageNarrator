// The viewer tab title is what the player card, reading queue, and saved resume entries
// show for a PDF, so it must name the document rather than the viewer.
export const DEFAULT_PDF_VIEWER_TITLE = 'PageNarrator PDF';

const MAX_TITLE_LENGTH = 120;
const GENERIC_TITLE_PATTERN = /^(?:untitled(?:\s+document)?|document\d*|title|none|null|undefined|\W*)$/i;
const AUTHORING_PREFIX_PATTERN = /^(?:microsoft\s+(?:word|powerpoint|excel)\s*-\s*)/i;
const FILE_EXTENSION_PATTERN = /\.(?:pdf|docx?|pptx?|xlsx?|odt|rtf|txt)$/i;

function cleanTitle(value) {
  const title = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(AUTHORING_PREFIX_PATTERN, '')
    .replace(FILE_EXTENSION_PATTERN, '')
    .trim();
  if (GENERIC_TITLE_PATTERN.test(title)) return '';
  return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…` : title;
}

function getFileNameTitle(sourceUrl) {
  try {
    const { pathname } = new URL(sourceUrl);
    const fileName = decodeURIComponent(pathname.split('/').pop() || '');
    return /\.pdf$/i.test(fileName) ? cleanTitle(fileName) : '';
  } catch {
    return '';
  }
}

export function getPdfDisplayTitle({ metadataTitle = '', sourceUrl = '' } = {}) {
  return cleanTitle(metadataTitle) || getFileNameTitle(sourceUrl) || DEFAULT_PDF_VIEWER_TITLE;
}
