import { expect, it } from 'vitest';
import { getPdfOcrRetryCrop, mapPdfOcrRetryLines, shouldUsePdfOcrRetry,
  preservePdfOcrConfidentWords, needsPdfOcrSourceRetry, preferRetriedPdfOcr, getPdfOcrSourceRetryCrop } from '../../src/lib/pdf-ocr-retry.js';

it('requires higher-resolution source pixels and coverage before replacing a suspicious slash word', () => {
  const bbox={x0:0,y0:0,x1:50,y1:20};
  const lines=(text,confidence=95,box=bbox)=>[{words:[{text,confidence,bbox:box}]}];
  expect(needsPdfOcrSourceRetry(lines('goa/s,'))).toBe(true);
  expect(needsPdfOcrSourceRetry(lines('AND/OR'))).toBe(false);
  expect(needsPdfOcrSourceRetry(lines('UML/SysML'))).toBe(false);
  expect(needsPdfOcrSourceRetry(lines('m/s'))).toBe(false);
  expect(preferRetriedPdfOcr(lines('goa/s,'),lines('goals'))).toBe(true);
  expect(preferRetriedPdfOcr(lines('word/s'),lines('word/s'))).toBe(false);
  expect(preferRetriedPdfOcr(lines('goa/s'),lines('goals',30))).toBe(false);
  const symbolEvidence=lines('goals',50);
  symbolEvidence[0].words[0].symbols=[...'goals'].map(text=>({text,confidence:95}));
  expect(preferRetriedPdfOcr(lines('goa/s'),symbolEvidence)).toBe(true);
  symbolEvidence[0].words[0].symbols[3].confidence=30;
  expect(preferRetriedPdfOcr(lines('goa/s'),symbolEvidence)).toBe(false);
  expect(preferRetriedPdfOcr(lines('goa/s'),lines('goals',95,{...bbox,x0:100,x1:150}))).toBe(false);
  expect(preferRetriedPdfOcr([{words:[...lines('goa/s')[0].words,...lines('complete passage')[0].words]}],lines('goals'))).toBe(false);
  expect(preferRetriedPdfOcr(lines('goa/s'),[{words:[...lines('goals')[0].words,...lines('invented passage')[0].words]}])).toBe(false);
});

it('bounds fresh source crops to suspicious lines and keeps their complete words', () => {
  const lines = [
    { words: [{ text: 'keep', bbox: { x0: 10, y0: 10, x1: 30, y1: 25 } }] },
    { words: [{ text: 'clear', bbox: { x0: 25, y0: 100, x1: 60, y1: 120 } }, { text: 'goa/s', bbox: { x0: 65, y0: 100, x1: 100, y1: 120 } }] },
  ];
  expect(getPdfOcrSourceRetryCrop(lines, 110, 140)).toEqual({ left: 5, top: 80, width: 105, height: 60 });
  expect(getPdfOcrSourceRetryCrop([lines[0]], 110, 140)).toBeNull();
});

it('pads whole boundary words, maps scaled boxes back, and rejects destructive retries', () => {
  const bbox = { x0: 8, y0: 20, x1: 80, y1: 40 };
  const lines = [{ bbox, baseline: { ...bbox, y0: 40 }, words: [{ text: 'requirements', confidence: 90, bbox }] }];
  const crop = getPdfOcrRetryCrop({ left: 20, top: 20, width: 60, height: 20 }, lines, 100, 100);
  expect(crop).toEqual({ left: 0, top: 10, width: 90, height: 40 });
  expect(mapPdfOcrRetryLines(lines, { left: 100, top: 200 }, 2)[0].words[0].bbox)
    .toEqual({ x0: 104, x1: 140, y0: 210, y1: 220 });
  expect(shouldUsePdfOcrRetry(lines, lines)).toBe(true);
  expect(shouldUsePdfOcrRetry(lines, [{ words: [{ text: 'req', confidence: 99 }] }])).toBe(false);
  expect(shouldUsePdfOcrRetry(lines, [{ words: [{ text: 'requirements', confidence: 60 }] }])).toBe(false);
  expect(shouldUsePdfOcrRetry(lines, [{ words: [{ text: 'requirements extra invented words', confidence: 99 }] }])).toBe(false);
  expect(shouldUsePdfOcrRetry(lines, [])).toBe(false);
  expect(shouldUsePdfOcrRetry([{ words: [
    { text: 'clear', confidence: 90 }, { text: 'goals', confidence: 90 },
  ] }], [{ words: [{ text: 'cleargoals', confidence: 99 }] }])).toBe(false);
  expect(lines[0].bbox).toEqual(bbox);
  const worse = [{ words: [{ text: 'reguirements', confidence: 20, bbox }] }];
  expect(preservePdfOcrConfidentWords(lines, worse)[0].words[0]).toBe(lines[0].words[0]);
  expect(preservePdfOcrConfidentWords(lines, [{ words: [{ ...worse[0].words[0],
    bbox: { ...bbox, x0: 200, x1: 280 } }] }])[0].words[0].text).toBe('reguirements');
});

it('allows missing-text recovery only for an explicitly bounded same-region retry', () => {
  const original = [{ words: [{ text: 'context', confidence: 90 }, { text: 'boundary', confidence: 90 }] }];
  const recovered = [{ words: [...original[0].words, { text: 'requirements', confidence: 95 }] }];
  expect(shouldUsePdfOcrRetry(original, recovered)).toBe(false);
  expect(shouldUsePdfOcrRetry(original, recovered, { sameSourceRegion: true })).toBe(true);
  expect(shouldUsePdfOcrRetry(original, [{ words: [{ text: 'contextboundaryrequirements', confidence: 99 }] }],
    { sameSourceRegion: true })).toBe(false);
  expect(shouldUsePdfOcrRetry(original, [{ words: recovered[0].words.map((word) => ({ ...word, confidence: 50 })) }],
    { sameSourceRegion: true })).toBe(false);
});


it('counts non-ASCII letters when protecting retry coverage and confident words', () => {
  const bbox={x0:0,y0:0,x1:30,y1:20};
  const lines=words=>[{words:words.map(text=>({text,confidence:90,bbox}))}];
  const original=lines(['mål','ö']);
  expect(shouldUsePdfOcrRetry(original,lines(['mål']))).toBe(false);
  expect(shouldUsePdfOcrRetry(lines(['åäö']),lines(['åäö']))).toBe(true);
  const before=lines(['åäö']);
  const candidate=lines(['aao']);
  candidate[0].words[0].confidence=30;
  expect(preservePdfOcrConfidentWords(before,candidate)[0].words[0]).toBe(before[0].words[0]);
});
