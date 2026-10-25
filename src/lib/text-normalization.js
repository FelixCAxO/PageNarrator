export function normalizeCodeText(value) {
  const lines = String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''));

  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  if (!lines.length) return '';

  const commonIndent = lines
    .filter((line) => line.trim())
    .map((line) => line.match(/^ */)?.[0].length || 0)
    .reduce((min, length) => Math.min(min, length), Number.POSITIVE_INFINITY);
  const indent = Number.isFinite(commonIndent) ? commonIndent : 0;

  return lines
    .map((line) => line.slice(indent))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
