// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { refinePdfOcrWordBounds } from './pdf-ocr-word-bounds.js';

const lines = data => (data?.blocks || []).flatMap(block => block.paragraphs || []).flatMap(part => part.lines || []);
const mixedCase = text => { const letters = text.replace(/[^A-Za-z]/g, '');
  return letters && !/^[a-z]+$/.test(letters) && !/^[A-Z]+$/.test(letters) && !/^[A-Z][a-z]+$/.test(letters); };
const validBox = (box, source) => box && ['x0', 'y0', 'x1', 'y1'].every(key => Number.isFinite(box[key]))
  && box.x0 >= 0 && box.y0 >= 0 && box.x1 <= source.width && box.y1 <= source.height
  && box.x1 > box.x0 && box.y1 > box.y0;
const overlap = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0))
  * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

// Source ink only requests verification; it never decides what a mark means.
export function analyzePunctuationSource(source, primary) {
  if (!source || !Number.isInteger(source.width) || !Number.isInteger(source.height)
    || source.width < 21 || source.height < 21 || source.width * source.height > 1_048_576
    || source.data?.length !== source.width * source.height * 4) return null;
  const original = lines(primary), words = original[0]?.words;
  if (original.length !== 1 || !Array.isArray(words) || !words.length || words.length > 512
    || words.some((word, index) => typeof word.text !== 'string' || mixedCase(word.text) || !validBox(word.bbox, source)
      || index && word.bbox.x0 < words[index - 1].bbox.x1)
    || /[^\x00-\x7f]|[0-9@\\/_{}\[\]<>*=+|\x60]/.test(words.map(word => word.text).join(' '))
    || !/^[A-Za-z]+$/.test(words.at(-1).text)) return null;
  // Detector crops redraw source in the horizontal border; keep the vertical search.
  // Frame edges expand by one row; two words cannot enter the three-anchor timing pass.
  if (source.height <= 22) return null;
  const frame = { top: 11, bottom: source.height - 11, left: 0, right: source.width, stepWidth: 1 };
  const word = words.at(-1), refined = refinePdfOcrWordBounds(words.slice(-2), source, 0, frame).at(-1).bbox;
  // Refinement adds a one-pixel border around ink; that border alone is no evidence.
  if (refined.x1 <= word.bbox.x1 + 1 || refined.x0 < word.bbox.x0 - 1) return null;
  return { index: words.length - 1, bbox: refined };
}

export function mergePunctuationSource(source, primary, independent) {
  const evidence = analyzePunctuationSource(source, primary);
  if (!evidence) return primary;
  const original = lines(primary)[0], checked = lines(independent);
  if (checked.length !== 1 || !Array.isArray(checked[0].words) || checked[0].words.length !== original.words.length) return primary;
  const words = checked[0].words, before = original.words[evidence.index], after = words[evidence.index];
  if (words.some((word, index) => !validBox(word.bbox, source)
    || index !== evidence.index && word.text !== original.words[index].text)
    || typeof after.text !== 'string' || !after.text.startsWith(before.text)
    || !/^[.,;:!?\u2026]$/u.test(after.text.slice(before.text.length))
    || !Number.isFinite(after.confidence) || after.confidence < 85
    || original.words.filter(word => overlap(word.bbox, after.bbox) > 0).length !== 1
    || overlap(before.bbox, after.bbox) < (before.bbox.x1 - before.bbox.x0) * (before.bbox.y1 - before.bbox.y0) * .5
    || Math.abs(after.bbox.x1 - evidence.bbox.x1) > 1
    || after.bbox.y0 > evidence.bbox.y0 + 1 || after.bbox.y1 < evidence.bbox.y1 - 1) return primary;
  const bbox = { x0: before.bbox.x0, x1: Math.max(before.bbox.x1, evidence.bbox.x1),
    y0: Math.min(before.bbox.y0, evidence.bbox.y0), y1: Math.max(before.bbox.y1, evidence.bbox.y1) };
  const corrected = { ...before, text: after.text, confidence: after.confidence, bbox };
  delete corrected.symbols;
  return { ...primary, blocks: primary.blocks.map(block => ({ ...block, paragraphs: block.paragraphs.map(part => ({ ...part,
    lines: part.lines.map(line => line === original ? { ...line, words: line.words.map((word, index) => index === evidence.index
      ? corrected : word) } : line) })) })) };
}
