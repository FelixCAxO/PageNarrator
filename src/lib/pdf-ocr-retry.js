export function getPdfOcrRetryCrop(rectangle, lines, width, height) {
  const words = lines.flatMap((line) => line.words || []).filter((word) =>
    word.bbox.x1 > rectangle.left && word.bbox.x0 < rectangle.left + rectangle.width
    && word.bbox.y1 > rectangle.top && word.bbox.y0 < rectangle.top + rectangle.height);
  if (!words.length) return null;
  const left = Math.max(0, Math.floor(Math.min(rectangle.left, ...words.map((word) => word.bbox.x0))) - 10);
  const top = Math.max(0, Math.floor(Math.min(rectangle.top, ...words.map((word) => word.bbox.y0))) - 10);
  const right = Math.min(width, Math.ceil(Math.max(rectangle.left + rectangle.width, ...words.map((word) => word.bbox.x1))) + 10);
  const bottom = Math.min(height, Math.ceil(Math.max(rectangle.top + rectangle.height, ...words.map((word) => word.bbox.y1))) + 10);
  return { left, top, width: right - left, height: bottom - top };
}

export function mapPdfOcrRetryLines(lines, crop, factor) {
  const box = ({ x0, x1, y0, y1 }) => ({ x0: x0 / factor + crop.left, x1: x1 / factor + crop.left,
    y0: y0 / factor + crop.top, y1: y1 / factor + crop.top });
  return lines.map((line) => ({ ...line, bbox: box(line.bbox),
    ...(line.baseline ? { baseline: box(line.baseline) } : {}),
    words: (line.words || []).map((word) => ({ ...word, bbox: box(word.bbox) })),
  }));
}

export function shouldUsePdfOcrRetry(original, candidate, { sameSourceRegion = false } = {}) {
  const stats = (lines) => lines.flatMap((line) => line.words || []).reduce((sum, word) => {
    const length = (word.text || '').replace(/[^\p{L}\p{N}]/gu, '').length;
    sum.words += length > 0 ? 1 : 0;
    sum.characters += length;
    sum.confidence += (Number.isFinite(word.confidence) ? word.confidence : 0) * length;
    return sum;
  }, { characters: 0, confidence: 0, words: 0 });
  const before = stats(original);
  const after = stats(candidate);
  // ponytail: conservative local evidence, not a spelling corrector or an accuracy guarantee.
  return after.characters > 0 && after.characters >= before.characters * 0.9
    && after.words >= before.words * 0.9
    && (sameSourceRegion || after.characters <= before.characters * 1.2)
    && after.confidence / after.characters >= before.confidence / Math.max(1, before.characters);
}

export function preservePdfOcrConfidentWords(original, candidate) {
  // ponytail: quadratic within one capped crop; index boxes if dense-page timings warrant it.
  const words = original.flatMap((line) => line.words || []);
  return candidate.map((line) => ({ ...line, words: (line.words || []).map((word) => {
    const matches = words.filter((before) => {
      const a = before.bbox;
      const b = word.bbox;
      const intersection = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0))
        * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
      const union = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - intersection;
      return union > 0 && intersection / union >= 0.6;
    });
    const before = matches.length === 1 ? matches[0] : null;
    return before && before.confidence >= word.confidence + 20
      && (before.text || '').replace(/[^\p{L}\p{N}]/gu, '').length >= 3 ? before : word;
  }) }));
}

// A slash standing for a letter is only a reason to verify, never to rewrite text.
export function needsPdfOcrSourceRetry(lines = []) {
  return lines.some(line=>(line.words || []).some(word=>/^[a-z]{3,}\/[a-z][,.;:!?]?$/i.test(word.text || '')));
}

export function getPdfOcrSourceRetryCrop(lines, width, height) {
  const words = lines.filter(line => needsPdfOcrSourceRetry([line])).flatMap(line => line.words || [])
    .filter(word => word.bbox && Object.values(word.bbox).every(Number.isFinite));
  if (!words.length) return null;
  const left = Math.max(0, Math.floor(Math.min(...words.map(word => word.bbox.x0))) - 20);
  const top = Math.max(0, Math.floor(Math.min(...words.map(word => word.bbox.y0))) - 20);
  const right = Math.min(width, Math.ceil(Math.max(...words.map(word => word.bbox.x1))) + 20);
  const bottom = Math.min(height, Math.ceil(Math.max(...words.map(word => word.bbox.y1))) + 20);
  return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
}

// Same-weight, higher-resolution source evidence; never independent model verification.
export function preferRetriedPdfOcr(neural, cpu) {
  const original=neural.flatMap(line=>line.words || []), checked=cpu.flatMap(line=>line.words || []);
  const letters=words=>words.reduce((sum,word)=>sum+(word.text || '').replace(/[^\p{L}\p{N}]/gu,'').length,0);
  const before=letters(original),after=letters(checked);
  if (!checked.length || checked.length < original.length*.9 || checked.length > Math.ceil(original.length*1.2)
    || after < before*.9 || after > Math.ceil(before*1.2)) return false;
  return original.some(word=>{
    const match=/^([a-z]{3,})\/([a-z])[,.;:!?]?$/i.exec(word.text || '');
    if (!match) return false;
    const spelling=new RegExp(`^${match[1]}[a-z]${match[2]}$`,'i');
    return checked.some(other=>{
      const symbols=other.symbols || [];
      const confidentSymbols=symbols.length>0 && symbols.map(symbol=>symbol.text).join('')===other.text
        && symbols.every(symbol=>Number.isFinite(symbol.confidence)&&symbol.confidence>=90);
      if (!(Number.isFinite(other.confidence)&&other.confidence>=85) && !confidentSymbols) return false;
      if (!spelling.test((other.text || '').replace(/^[^a-z]+|[^a-z]+$/gi,''))) return false;
      const a=word.bbox,b=other.bbox;
      const intersection=Math.max(0,Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0))
        *Math.max(0,Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0));
      return intersection > 0 && intersection >= Math.min((a.x1-a.x0)*(a.y1-a.y0),(b.x1-b.x0)*(b.y1-b.y0))*.5;
    });
  });
}
