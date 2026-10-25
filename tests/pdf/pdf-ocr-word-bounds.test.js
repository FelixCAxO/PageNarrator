import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { refinePdfOcrWordBounds } from '../../src/lib/pdf-ocr-word-bounds.js';

function pixels(width = 100, height = 50, background = [255, 255, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) data.set([...background, 255], p * 4);
  return { data, width, height };
}
function rectangle(image, left, top, right, bottom, color = [0, 0, 0]) {
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) image.data.set([...color, 255], (y * image.width + x) * 4);
}
const word = (x0, x1) => ({ text: 'word', confidence: 97, bbox: { x0, y0: 10, x1, y1: 40 } });

it('uses visible ink instead of CTC timing edges and keeps confidence and text', () => {
  const image = pixels(); rectangle(image, 24, 18, 42, 33);
  const input = [word(30, 48)];
  expect(refinePdfOcrWordBounds(input, image)).toEqual([{ ...input[0], bbox: { x0: 23, y0: 17, x1: 43, y1: 34 } }]);
  expect(input[0].bbox.x0).toBe(30);
});
it('handles light lettering on a colored background', () => {
  const image = pixels(100, 50, [0, 125, 180]); rectangle(image, 24, 18, 42, 33, [255, 255, 255]);
  expect(refinePdfOcrWordBounds([word(30, 48)], image)[0].bbox).toEqual({ x0: 23, y0: 17, x1: 43, y1: 34 });
});
it('keeps neighboring words separate and ignores table rules reaching an edge', () => {
  const image = pixels(); rectangle(image, 24, 18, 35, 33); rectangle(image, 57, 18, 72, 33);
  rectangle(image, 0, 11, 100, 12);
  const output = refinePdfOcrWordBounds([word(25, 36), word(56, 73)], image);
  expect(output.map(item => item.bbox)).toEqual([{ x0: 23, y0: 17, x1: 36, y1: 34 }, { x0: 56, y0: 17, x1: 73, y1: 34 }]);
});
it('retains the estimate when visible evidence is absent or too weak', () => {
  for (const image of [pixels(), pixels(100, 50, [140, 140, 140])]) {
    const input = [word(25, 48)];
    expect(refinePdfOcrWordBounds(input, image)[0]).toBe(input[0]);
  }
});

it('refines an actual CTC span extending into retained right pixel context', () => {
  const image = pixels(); rectangle(image, 90, 18, 97, 33);
  const input = [word(82, 94)];
  expect(refinePdfOcrWordBounds(input, image)[0]).toEqual({ ...input[0], bbox: { x0: 89, y0: 17, x1: 98, y1: 34 } });
});

it('finishes a cut initial glyph using real source pixels inside the model border', () => {
  const image=pixels();
  rectangle(image,6,18,25,21);rectangle(image,13,21,18,33);rectangle(image,36,18,44,33);
  const input=[word(24,65)],frame={top:10,bottom:40,stepWidth:12.5};
  expect(refinePdfOcrWordBounds(input,image,10,frame)[0].bbox).toEqual({x0:35,y0:17,x1:45,y1:34});
  const actual=refinePdfOcrWordBounds(input,image,10,{...frame,left:0,right:100})[0];
  expect(actual).toEqual({...input[0],bbox:{x0:5,y0:17,x1:45,y1:34}});
  // Identical pixels outside the declared source are synthetic and cannot help.
  expect(refinePdfOcrWordBounds(input,image,10,{...frame,left:10,right:90})[0].bbox).toEqual({x0:35,y0:17,x1:45,y1:34});
});

it('uses real right context but excludes ink outside the declared source extent', () => {
  const image=pixels();rectangle(image,70,18,86,33);
  rectangle(image,88,18,97,21);rectangle(image,92,21,95,33);
  const input=[word(70,88)],frame={top:10,bottom:40,stepWidth:12.5,left:0,right:100};
  expect(refinePdfOcrWordBounds(input,image,10,frame)[0].bbox).toEqual({x0:69,y0:17,x1:98,y1:34});
  expect(refinePdfOcrWordBounds(input,image,10,{...frame,right:90})[0].bbox).toEqual({x0:69,y0:17,x1:87,y1:34});
});

it('does not attach separated right-context ink without a matching established glyph gap', () => {
  const image=pixels();rectangle(image,70,18,80,33);
  rectangle(image,88,18,97,21);rectangle(image,92,21,95,33);
  const input=[word(70,88)],frame={top:10,bottom:40,stepWidth:12.5,left:0,right:100};
  expect(refinePdfOcrWordBounds(input,image,10,frame)[0].bbox).toEqual({x0:69,y0:17,x1:81,y1:34});
});

it.each([false, true])('recovers a glyph cut by a neighboring timestamp midpoint (light=%s)', light => {
  const image = pixels(120, 50, light ? [14, 14, 14] : [255, 255, 255]);
  const color = light ? [140, 140, 140] : [0, 0, 0];
  rectangle(image, 20, 18, 29, 33, color);
  rectangle(image, 35, 18, 43, 33, color);
  rectangle(image, 46, 18, 55, 33, color); rectangle(image, 58, 18, 70, 33, color);
  const input = [word(20, 30), word(45, 75)]; // Midpoint37 falls inside the first glyph.
  expect(refinePdfOcrWordBounds(input, image).map(value => value.bbox)).toEqual([
    { x0: 19, y0: 17, x1: 30, y1: 34 }, { x0: 34, y0: 17, x1: 71, y1: 34 },
  ]);
});

it('recovers a cut right glyph without crossing the next word center', () => {
  const image = pixels(120, 50);
  rectangle(image, 24, 18, 30, 33); rectangle(image, 34, 18, 42, 33); rectangle(image, 46, 18, 53, 33);
  rectangle(image, 60, 18, 72, 33);
  const input = [word(25, 40), word(60, 74)]; // Midpoint50 falls inside the right glyph.
  expect(refinePdfOcrWordBounds(input, image).map(value => value.bbox)).toEqual([
    { x0: 23, y0: 17, x1: 54, y1: 34 }, { x0: 59, y0: 17, x1: 73, y1: 34 },
  ]);
});

it('does not follow a rule or unbounded connected ink into another word', () => {
  const image = pixels(120, 50);
  rectangle(image, 0, 11, 120, 12); rectangle(image, 20, 18, 29, 33);
  rectangle(image, 35, 18, 70, 33);
  const output = refinePdfOcrWordBounds([word(20, 30), word(45, 75)], image);
  expect(output[0].bbox).toEqual({ x0: 19, y0: 17, x1: 30, y1: 34 });
  expect(output[1].bbox.x0).toBeGreaterThanOrEqual(37);
});

it('does not add an edge-cut preceding checkbox across a word-size gap', () => {
  const image=pixels(150,50);
  rectangle(image,50,18,61,33); // Unrecognized preceding control crosses the search edge55.
  rectangle(image,75,18,83,33);rectangle(image,85,18,93,33);rectangle(image,95,18,110,33);
  expect(refinePdfOcrWordBounds([word(70,120)],image)[0].bbox).toEqual({x0:74,y0:17,x1:111,y1:34});
});

it('does not attach the following word first glyph when its timestamp runs late', () => {
  const image=pixels(140,50);
  rectangle(image,40,18,46,33);rectangle(image,48,18,54,33);rectangle(image,56,18,62,33);
  rectangle(image,68,18,73,33);rectangle(image,76,18,84,33);rectangle(image,86,18,98,33);
  const result=refinePdfOcrWordBounds([word(40,67),word(74,102)],image);
  expect(result[0].bbox).toEqual({x0:39,y0:17,x1:63,y1:34});
});

it('keeps a wholly unrefinable timestamp instead of assigning another source glyph', () => {
  const image=pixels(100,50);rectangle(image,35,18,43,33);
  const input=[word(20,30),word(45,60)];
  expect(refinePdfOcrWordBounds(input,image)[1]).toBe(input[1]);
});

it('finishes a wide initial glyph before measuring its gap to established word ink', () => {
  const image=pixels(187,43,[113,113,113]),color=[255,255,255];
  // Source-derived dimensions: an18px glyph crosses midpoint40, while the
  // line's half-height search reaches only52. The complete glyph ends58.
  rectangle(image,40,12,58,30,color);rectangle(image,60,17,67,30,color);
  rectangle(image,67,11,80,30,color);rectangle(image,82,16,94,29,color);rectangle(image,96,16,103,29,color);
  for(const[l,t,r,b]of[[40,12,58,30],[60,17,67,30],[67,11,80,30],[82,16,94,29],[96,16,103,29]])rectangle(image,l+2,t+2,r-2,b-2,[113,113,113]);
  const input=[{...word(17.6667,33),bbox:{x0:17.6667,y0:10,x1:33,y1:33}},
    {...word(48.3333,102),bbox:{x0:48.3333,y0:10,x1:102,y1:33}},
    {...word(117.3333,167.1667),bbox:{x0:117.3333,y0:10,x1:167.1667,y1:33}}];
  expect(refinePdfOcrWordBounds(input,image)[1].bbox).toEqual({x0:39,y0:10,x1:104,y1:31});
});

it('finishes a wide final glyph without mistaking its cut component for a border', () => {
  const image=pixels(71,41,[14,14,14]),color=[153,153,153];
  rectangle(image,13,14,20,29,color);rectangle(image,21,14,35,29,color);rectangle(image,36,14,56,29,color);
  for(const[l,r]of[[13,20],[21,35],[36,56]])rectangle(image,l+2,16,r-2,27,[14,14,14]);
  const input=[{text:'wide final glyph',confidence:97,bbox:{x0:17,y0:10,x1:45,y1:31}}];
  expect(refinePdfOcrWordBounds(input,image)[0]).toEqual({...input[0],bbox:{x0:12,y0:13,x1:57,y1:30}});
});

it('finishes a kerned cut component even when its column projection overlaps the next glyph', () => {
  const image=pixels(120,50);
  rectangle(image,20,18,29,33);
  rectangle(image,35,18,44,20);rectangle(image,38,20,40,32);
  rectangle(image,42,24,51,33);rectangle(image,54,18,65,33);
  const result=refinePdfOcrWordBounds([word(20,30),word(45,75)],image);
  expect(result[0].bbox.x1).toBe(30);
  expect(result[1].bbox).toEqual({x0:34,y0:17,x1:66,y1:34});
});

it('uses bounded source timing anchors for a short numeral and tiny punctuation without taking a neighboring glyph', async () => {
  const fixture=JSON.parse(readFileSync(new URL('../fixtures/ocr/source-word-status.json',import.meta.url),'utf8'));
  const bytes=readFileSync(new URL('../fixtures/ocr/source-word-status.png',import.meta.url));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(fixture.pngSha256);
  const{data,info}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true}),image={data,width:info.width,height:info.height};
  const result=refinePdfOcrWordBounds(fixture.words,image,10,fixture.frame);
  expect(result.map(w=>[w.text,w.confidence])).toEqual(fixture.words.map(w=>[w.text,w.confidence]));
  const covered=(rect,bbox)=>{let ink=0,count=0;for(let y=rect[1];y<rect[3];y++)for(let x=rect[0];x<rect[2];x++){
    const p=(y*info.width+x)*4;if((data[p]*77+data[p+1]*150+data[p+2]*29)/256>80){ink++;
      if(x+.5>=bbox.x0&&x+.5<bbox.x1&&y+.5>=bbox.y0&&y+.5<bbox.y1)count++;}
  }return{ink,count};};
  for(const gold of fixture.gold){
    const actual=covered(gold.rect,result[gold.index].bbox);
    expect(actual.ink).toBe(gold.ink);expect(actual.count).toBe(gold.ink);
    expect(covered(gold.other,result[gold.index].bbox).count).toBe(0);
  }
  // A correction outside the model's one-bin bound must not run a second pass.
  const onePass=refinePdfOcrWordBounds(fixture.words,image,10,{...fixture.frame,stepWidth:.01});
  expect(onePass[5].bbox).toEqual(fixture.words[5].bbox);
});

it.each([{top:-1,bottom:30,stepWidth:2},{top:30,bottom:20,stepWidth:2},{top:10,bottom:51,stepWidth:2},{top:10,bottom:40,stepWidth:NaN},
  ...[{left:0},{left:-1,right:90},{left:0,right:101},{left:30,right:20},{left:.5,right:90}].map(bounds=>({top:10,bottom:40,stepWidth:2,...bounds}))])('rejects malformed source word frames', frame => {
  expect(()=>refinePdfOcrWordBounds([word(25,40)],pixels(),10,frame)).toThrow('source word frame');
});

const sourceControls=JSON.parse(readFileSync(new URL('../fixtures/ocr/source-word-controls.json',import.meta.url),'utf8'));
it.each(sourceControls.fixtures)('retains every independently frozen $gold.word source pixel after frame and timing refinement',async fixture=>{
  const bytes=readFileSync(new URL(`../fixtures/ocr/${fixture.file}`,import.meta.url));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(fixture.pngSha256);
  const{data,info}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  expect(createHash('sha256').update(data).digest('hex')).toBe(fixture.pixelSha256);
  const output=refinePdfOcrWordBounds(fixture.words,{data,width:info.width,height:info.height},10,fixture.frame);
  expect(output.map(w=>[w.text,w.confidence])).toEqual(fixture.words.map(w=>[w.text,w.confidence]));
  const gold=fixture.gold,box=output[gold.index].bbox,mask=[];let ink=0,covered=0;
  for(let y=gold.rect[1];y<gold.rect[3];y++)for(let x=gold.rect[0];x<gold.rect[2];x++){
    const p=(y*info.width+x)*4,foreground=(data[p]*77+data[p+1]*150+data[p+2]*29)/256>gold.threshold;
    mask.push(Number(foreground));if(!foreground)continue;ink++;
    if(x+.5>=box.x0&&x+.5<box.x1&&y+.5>=box.y0&&y+.5<box.y1)covered++;
  }
  expect(createHash('sha256').update(Uint8Array.from(mask)).digest('hex')).toBe(gold.maskSha256);
  expect(ink).toBe(gold.foregroundPixels);expect(covered).toBe(ink);
});

const sourceContext=JSON.parse(readFileSync(new URL('../fixtures/ocr/source-word-context.json',import.meta.url),'utf8'));
it.each(sourceContext.fixtures)('preserves source ink ownership for authored geometry and owned UI in $file',async fixture=>{
  const bytes=readFileSync(new URL(`../fixtures/ocr/${fixture.file}`,import.meta.url));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(fixture.pngSha256);
  const{data,info}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  expect(createHash('sha256').update(data).digest('hex')).toBe(fixture.pixelSha256);
  const originalWords=structuredClone(fixture.words);
  const output=refinePdfOcrWordBounds(fixture.words,{data,width:info.width,height:info.height},10,fixture.frame);
  expect(fixture.words).toEqual(originalWords);
  expect(output.map(w=>[w.text,w.confidence])).toEqual(fixture.words.map(w=>[w.text,w.confidence]));
  expect(output.map(w=>w.bbox)).toEqual(fixture.expected);
  for(const[key,gold]of[['own',fixture.own],['neighbor',fixture.neighbor]]){
    if(!gold)continue;
    const box=output[0].bbox,mask=[];let covered=0;
    for(let y=gold.rect[1];y<gold.rect[3];y++)for(let x=gold.rect[0];x<gold.rect[2];x++){
      const p=(y*info.width+x)*4,foreground=(data[p]*77+data[p+1]*150+data[p+2]*29)/256<gold.threshold;
      mask.push(Number(foreground));
      if(foreground&&x+.5>=box.x0&&x+.5<box.x1&&y+.5>=box.y0&&y+.5<box.y1)covered++;
    }
    expect(createHash('sha256').update(Uint8Array.from(mask)).digest('hex')).toBe(gold.maskSha256);
    expect(mask.reduce((sum,value)=>sum+value,0)).toBe(gold.foregroundPixels);
    expect(covered).toBe(key==='own'?gold.foregroundPixels:0);
  }
});
