// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { needsPdfOcrSourceRetry, preferRetriedPdfOcr } from './pdf-ocr-retry.js';
import { analyzeSpacingSource, mergeSpacingSource } from './pdf-ocr-spacing.js';
import { mapPdfOcrShearedBox } from './pdf-ocr-grid.js';
import { analyzePunctuationSource, mergePunctuationSource } from './pdf-ocr-punctuation.js';
import { createPdfOcrCanvas } from './pdf-ocr-canvas.js';

// Four shared whole-line attempts: legacy slash checks first, then uncertain
// letters and source-gap spacing, with the existing 85%/coverage/overlap policy.
export const PDF_OCR_VERIFICATION_POLICY = Object.freeze({ maximumLines: 4, maximumPixels: 1_048_576, maximumWords: 512,
  independentConfidence: 'mean-emitted-character-run-peak', minimumConfidence: 85 });
const lines = data => (data?.blocks || []).flatMap(block => block.paragraphs || []).flatMap(part => part.lines || []);
const proseLine = words => !/[^\x00-\x7f]|[0-9@\\/_{}\[\]<>*=+|\x60]/.test(words.map(word => word.text).join(' '))
  && words.every(word => { const letters = (word.text || '').replace(/[^A-Za-z]/g, '');
    return !letters || /^[a-z]+$|^[A-Z]+$|^[A-Z][a-z]+$/.test(letters); });
const uncertainWord = word => /^[A-Za-z]+[,.;:!?]?$/.test(word.text || '') && Array.isArray(word.symbols)
  && word.symbols.length === word.text.length && word.symbols.every((symbol, index) => symbol.text === word.text[index]
    && Number.isFinite(symbol.confidence) && symbol.confidence >= 0 && symbol.confidence <= 100)
  && word.symbols.some(symbol => /^[A-Za-z]$/.test(symbol.text) && symbol.confidence < PDF_OCR_VERIFICATION_POLICY.minimumConfidence);
const uncertainLine = original => original.length === 1 && !needsPdfOcrSourceRetry(original)
  && proseLine(original[0].words || [])
  && (original[0].words || []).some(uncertainWord);
const overlap = (a, b) => a && b && [...Object.values(a), ...Object.values(b)].every(Number.isFinite)
  && a.x1 > a.x0 && a.y1 > a.y0 && b.x1 > b.x0 && b.y1 > b.y0
  && Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0))
    >= Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0)) * .5;
function verifiedWord(word, candidate) {
  const result = { ...word, text: candidate.text, confidence: candidate.confidence };
  if (Array.isArray(candidate.symbols) && candidate.symbols.map(symbol => symbol.text).join('') === candidate.text) result.symbols = candidate.symbols;
  else delete result.symbols;
  return result;
}
function replaceWords(primary, original, words) {
  return { ...primary, blocks: primary.blocks.map(block => ({ ...block, paragraphs: block.paragraphs.map(part => ({ ...part,
    lines: part.lines.map(line => line === original ? { ...line, words } : line) })) })) };
}

function insideSource(box, projection) {
  const { left, top, originX, slope, sourceWidth, sourceHeight } = projection || {};
  if (![left, top, originX, slope].every(Number.isFinite)
    || !Number.isInteger(sourceWidth) || sourceWidth <= 0 || !Number.isInteger(sourceHeight) || sourceHeight <= 0) return false;
  let mapped;
  try { mapped = mapPdfOcrShearedBox(box, { left, top, originX, slope, sourceWidth, sourceHeight }); }
  catch { return false; }
  // Boundary contact cannot establish whether missing source ink continues a glyph.
  return mapped && mapped.x0 > 0 && mapped.y0 > 0 && mapped.x1 < sourceWidth && mapped.y1 < sourceHeight;
}

/** Independent recognition may change only uncertain positions in an otherwise literal word. */
export function mergePdfOcrUncertainLine(primary, independent, sourceProjection) {
  const original = lines(primary), checked = lines(independent), words = original[0]?.words || [], candidates = checked[0]?.words || [];
  const letters = values => values.reduce((sum, word) => sum + (word.text || '').replace(/[^\p{L}\p{N}]/gu, '').length, 0);
  const before = letters(words), after = letters(candidates);
  if (!uncertainLine(original) || checked.length !== 1 || words.length > PDF_OCR_VERIFICATION_POLICY.maximumWords
    || candidates.length !== words.length || after < before * .9 || after > Math.ceil(before * 1.2)) return primary;
  let changed = false;
  const result = words.map((word, wordIndex) => {
    if (!uncertainWord(word)) return word;
    const matches = candidates.filter(candidate => overlap(word.bbox, candidate.bbox));
    if (matches.length !== 1 || !insideSource(word.bbox, sourceProjection) || !insideSource(matches[0].bbox, sourceProjection)) return word;
    const candidate = matches[0], symbols = Array.isArray(candidate.symbols) ? candidate.symbols : [];
    if (candidate !== candidates[wordIndex]
      || wordIndex > 0 && candidates[wordIndex - 1].text !== words[wordIndex - 1].text
      || wordIndex + 1 < words.length && candidates[wordIndex + 1].text !== words[wordIndex + 1].text) return word;
    const confidentSymbols = symbols.length > 0 && symbols.map(symbol => symbol.text).join('') === candidate.text
      && symbols.every(symbol => Number.isFinite(symbol.confidence) && symbol.confidence >= 90);
    if (!(Number.isFinite(candidate.confidence) && candidate.confidence >= PDF_OCR_VERIFICATION_POLICY.minimumConfidence) && !confidentSymbols) return word;
    if (typeof candidate.text !== 'string' || candidate.text.length !== word.text.length || candidate.text === word.text
      || words.some(other => other !== word && overlap(other.bbox, candidate.bbox))) return word;
    for (let index = 0; index < word.text.length; index++) {
      if (word.text[index] === candidate.text[index]) continue;
      if (!/^[A-Za-z]$/.test(word.text[index]) || !/^[A-Za-z]$/.test(candidate.text[index])
        || word.symbols[index].confidence >= PDF_OCR_VERIFICATION_POLICY.minimumConfidence) return word;
    }
    changed = true;
    return verifiedWord(word, candidate);
  });
  return changed ? replaceWords(primary, original[0], result) : primary;
}

/** Preserve every primary word and box except individually corroborated suspicious text. */
export function mergePdfOcrIndependentLine(primary, independent) {
  const original = lines(primary), checked = lines(independent);
  if (original.length !== 1 || checked.length !== 1 || !needsPdfOcrSourceRetry(original)
    || original[0].words?.length > PDF_OCR_VERIFICATION_POLICY.maximumWords
    || !preferRetriedPdfOcr(original, checked)) return primary;
  let changed = false;
  const words = original[0].words.map(word => {
    if (!needsPdfOcrSourceRetry([{ words: [word] }])) return word;
    const matches = checked[0].words.filter(candidate => preferRetriedPdfOcr([{ words: [word] }], [{ words: [candidate] }]));
    if (matches.length !== 1) return word;
    changed = true;
    return verifiedWord(word, matches[0]);
  });
  if (!changed) return primary;
  return replaceWords(primary, original[0], words);
}

export function boundedPdfOcrVerifier(recognize, cancelled = () => false, onError = () => null) {
  let used = 0, failed = false;
  const remaining = () => !failed && !cancelled() && used < PDF_OCR_VERIFICATION_POLICY.maximumLines;
  const readable = (source, primary) => {
    const original = lines(primary);
    return original.length === 1 && original[0].words?.length <= PDF_OCR_VERIFICATION_POLICY.maximumWords
      && Number.isInteger(source?.width) && Number.isInteger(source?.height) && source.width >= 21 && source.height >= 21
      && source.width * source.height <= PDF_OCR_VERIFICATION_POLICY.maximumPixels;
  };
  const pixels = source => ({ width: source.width, height: source.height,
    data: source.getContext('2d').getImageData(0, 0, source.width, source.height).data });
  // Spacing and terminal punctuation share the same bounded independent read.
  const mergeSource = (image, raw, independent, updated = raw) => {
    const analysis = analyzeSpacingSource(image, raw);
    const spaced = analysis.eligible ? mergeSpacingSource(image, updated, independent, analysis).data : updated;
    return mergePunctuationSource(image, spaced, independent);
  };
  const read = async (source, primary, merge) => {
    if (!remaining() || !readable(source, primary)) return primary;
    let context;
    try {
      const punctuation = !needsPdfOcrSourceRetry(lines(primary)) && typeof source.getContext === 'function'
        && analyzePunctuationSource(pixels(source), primary);
      if (punctuation && (source.width + 10) * source.height > PDF_OCR_VERIFICATION_POLICY.maximumPixels) return primary;
      used++;
      if (punctuation) {
        // English recognition removes ten pixels per edge; expose retained right source context.
        context = createPdfOcrCanvas(source.width + 10, source.height);
        const target = context.getContext('2d');
        target.fillStyle = 'white'; target.fillRect(0, 0, context.width, context.height);
        target.drawImage(source, 0, 0);
      }
      if (cancelled()) return primary;
      const independent = await recognize(context || source);
      return cancelled() ? primary : merge(primary, independent);
    } catch (error) { failed = true; onError(error); return primary; }
    finally { if (context) context.width = context.height = 0; }
  };
  const verify = (source, primary) => needsPdfOcrSourceRetry(lines(primary))
    ? read(source, primary, mergePdfOcrIndependentLine) : Promise.resolve(primary);
  verify.uncertainCandidate = (source, primary) => remaining() && readable(source, primary) && uncertainLine(lines(primary));
  verify.verifyUncertain = (source, primary, sourceProjection) => uncertainLine(lines(primary))
    ? read(source, primary, (raw, independent) => {
      const updated = mergePdfOcrUncertainLine(raw, independent, sourceProjection);
      if (typeof source.getContext !== 'function') return updated;
      // The same read can also support source spacing and terminal punctuation.
      // Letter changes keep original word indices/boxes, so raw source gaps still apply.
      return mergeSource(pixels(source), raw, independent, updated);
    }) : Promise.resolve(primary);
  verify.spacingCandidate = (source, primary) => {
    if (!remaining() || !readable(source, primary) || typeof source.getContext !== 'function'
      || needsPdfOcrSourceRetry(lines(primary))) return false;
    const image = pixels(source);
    return analyzeSpacingSource(image, primary).eligible || !!analyzePunctuationSource(image, primary);
  };
  verify.spacingRemaining = remaining;
  verify.verifySpacing = (source, primary) => {
    if (!remaining() || !readable(source, primary) || typeof source.getContext !== 'function') return Promise.resolve(primary);
    const image = pixels(source);
    return analyzeSpacingSource(image, primary).eligible || analyzePunctuationSource(image, primary)
      ? read(source, primary, (raw, independent) => mergeSource(image, raw, independent))
      : Promise.resolve(primary);
  };
  return verify;
}
