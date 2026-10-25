import { expect, it } from 'vitest';
import { ocrWordErrorRate, isOcrWordInRegion, validateOcrReferenceRegions } from '../helpers/ocr-word-error-rate.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

it('validates reference geometry independently of returned OCR words', () => {
  const valid={text:'Reference words',rect:[0,0,1,1]};
  expect(()=>validateOcrReferenceRegions([valid])).not.toThrow();
  for(const regions of [[],undefined,[null],[{...valid,text:' '}],
    ...[[0,0,0,1],[0,0,1.1,1],[0,0,NaN,1],[-.1,0,1,1],[0,0,1]].map(rect=>[{...valid,rect}]),
    [{text:'Words',polygons:[[[0,0],[1,0],[1,1],[0,1]],[[0,0],[1,1],[1,0],[0,1]]]}]])
    expect(()=>validateOcrReferenceRegions(regions)).toThrow();
});

it('scores folded regions as a union without filling the concave gap or duplicating words', () => {
  const polygons = [[[0,0],[.5,0],[.5,1],[0,1]], [[.5,0],[1,0],[1,.5],[.5,.5]]];
  expect(isOcrWordInRegion({x:.25,y:.75},{polygons})).toBe(true);
  expect(isOcrWordInRegion({x:.75,y:.25},{polygons})).toBe(true);
  expect(isOcrWordInRegion({x:.75,y:.75},{polygons})).toBe(false);
  expect(isOcrWordInRegion({x:.5,y:.5},{polygons})).toBe(true);
  for (const region of [{polygons:[]}, {polygons,rect:[0,0,1,1]},
    {polygons,polygon:polygons[0]}, {polygons:[polygons[0],[[0,0],[1,1],[1,0],[0,1]]]}])
    expect(()=>isOcrWordInRegion({x:.25,y:.25},region)).toThrow();
});

it('scores slanted regions without including neighboring-column centers', () => {
  const polygon=[[.2,.3],[.4,.2],[.5,.7],[.3,.8]];
  for(const points of [polygon,polygon.slice().reverse()]){
    expect(isOcrWordInRegion({x:.35,y:.5},{polygon:points})).toBe(true);
    expect(isOcrWordInRegion({x:.2,y:.7},{polygon:points})).toBe(false);
    expect(isOcrWordInRegion({x:.2,y:.3},{polygon:points})).toBe(true);
  }
  expect(isOcrWordInRegion({x:.2,y:.7},{rect:[.2,.2,.3,.6]})).toBe(true);
  expect(()=>isOcrWordInRegion({x:0,y:0},{polygon:[[0,0],[1,1],[1,0],[0,1]]})).toThrow();
  expect(()=>isOcrWordInRegion({x:0,y:0},{polygon:[[0,0],[NaN,0],[1,1],[0,1]]})).toThrow();
});

it('scores substitutions, insertions, deletions and empty OCR without hiding missing words', () => {
  expect(ocrWordErrorRate('One, two THREE.', 'one two three').rate).toBe(0);
  expect(ocrWordErrorRate('one two three', 'one wrong three extra').errors).toBe(2);
  expect(ocrWordErrorRate('one two three', 'one three').errors).toBe(1);
  expect(ocrWordErrorRate('one two three', '').rate).toBe(1);
});

it('pins original authored reference metadata without pretending it is a photographed quality corpus', () => {
  const root = new URL('../fixtures/ocr/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('authored-reference-corpus.json', root), 'utf8'));
  expect(manifest.pages).toHaveLength(2);
  expect(new Set(manifest.pages.map((entry) => entry.page)).size).toBe(2);
  expect(manifest.sourceKind).toBe('authored-schema-control-no-recognition');
  expect(manifest.pages.map((entry) => entry.page)).toEqual([1, 2]);
  for (const entry of manifest.pages) {
    const bytes = readFileSync(new URL(entry.referenceFile, root));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.referenceSha256);
    const reference = JSON.parse(bytes);
    expect(reference.referenceStatus).toBe('authored');
    expect(reference.page).toBe(entry.page);
    expect(reference.regions.length).toBeGreaterThan(0);
    for (const region of reference.regions) {
      expect(region.text.trim().length).toBeGreaterThan(0);
      expect(region.rect).toHaveLength(4);
      const [x, y, width, height] = region.rect;
      expect(region.rect.every(Number.isFinite)).toBe(true);
      expect(Math.min(x, y)).toBeGreaterThanOrEqual(0);
      expect(Math.min(width, height)).toBeGreaterThan(0);
      expect(Math.max(x + width, y + height)).toBeLessThanOrEqual(1);
    }
  }
});
