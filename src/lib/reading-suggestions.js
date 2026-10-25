const WORDS_PER_MINUTE = 155;
const CODE_DENSITY_THRESHOLD = 0.2;

export function getCodeDensity(chunks = []) {
  if (!Array.isArray(chunks) || chunks.length === 0) return 0;
  const codeCount = chunks.filter((chunk) => chunk?.type === 'code').length;
  return codeCount / chunks.length;
}

export function createCodeCleanupSuggestion({
  skipCodeSnippets = false,
  chunks = [],
} = {}) {
  if (skipCodeSnippets || getCodeDensity(chunks) < CODE_DENSITY_THRESHOLD) {
    return { visible: false };
  }

  const codeWords = chunks
    .filter((chunk) => chunk?.type === 'code')
    .reduce((sum, chunk) => sum + countWords(chunk?.speech || chunk?.text || ''), 0);
  const estimatedMinutes = Math.max(1, Math.round(codeWords / WORDS_PER_MINUTE));

  return {
    visible: true,
    title: 'Skip code snippets?',
    detail: `This page has many code snippets. Skip about ${estimatedMinutes} ${estimatedMinutes === 1 ? 'min' : 'mins'} of code for smoother narration.`,
    estimatedMinutes,
  };
}

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}
