// Case/punctuation-insensitive WER; insertions and omissions still count.
export function validateOcrReferenceRegions(regions) {
  if (!Array.isArray(regions) || !regions.length) throw new Error('Missing OCR reference regions');
  for (const region of regions) {
    if (!region || typeof region.text !== 'string' || !region.text.trim()) throw new Error('Missing OCR reference text');
    isOcrWordInRegion({x:0,y:0}, region);
  }
}

export function isOcrWordInRegion(word, region) {
  if (region.polygons !== undefined) {
    if (region.rect || region.polygon || !Array.isArray(region.polygons) || !region.polygons.length)
      throw new Error('Expected a nonempty union of convex quadrilaterals');
    // Validate every component even when an earlier component contains the word.
    return region.polygons.map(polygon => isOcrWordInRegion(word, { polygon })).some(Boolean);
  }
  if (!region.polygon) {
    if (!Array.isArray(region.rect) || region.rect.length !== 4 || !region.rect.every(Number.isFinite))
      throw new Error('Expected a normalized rectangle');
    const [x,y,width,height]=region.rect;
    if (x<0 || y<0 || width<=0 || height<=0 || x+width>1 || y+height>1)
      throw new Error('Expected a normalized rectangle');
    return word.x>=x&&word.x<=x+width&&word.y>=y&&word.y<=y+height;
  }
  const points=region.polygon;
  if(region.rect || points.length!==4 || !points.every(p=>Array.isArray(p)&&p.length===2&&p.every(v=>Number.isFinite(v)&&v>=0&&v<=1)))
    throw new Error('Expected one normalized convex quadrilateral');
  const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const turns=points.map((p,i)=>cross(p,points[(i+1)%4],points[(i+2)%4]));
  if(!turns.every(v=>v>0)&&!turns.every(v=>v<0))throw new Error('Expected convex quadrilateral');
  const sides=points.map((p,i)=>cross(p,points[(i+1)%4],[word.x,word.y]));
  return sides.every(v=>v>=-1e-10)||sides.every(v=>v<=1e-10);
}

export function ocrWordErrorRate(reference, recognized) {
  const words = (text) => text.toLowerCase().match(/[a-z0-9]+/g) || [];
  const expected = words(reference);
  const actual = words(recognized);
  let previous = Array.from({ length: actual.length + 1 }, (_, i) => i);
  for (let i = 0; i < expected.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < actual.length; j++) {
      next.push(Math.min(next[j] + 1, previous[j + 1] + 1,
        previous[j] + Number(expected[i] !== actual[j])));
    }
    previous = next;
  }
  return { errors: previous[actual.length], referenceWords: expected.length,
    rate: previous[actual.length] / Math.max(1, expected.length) };
}
