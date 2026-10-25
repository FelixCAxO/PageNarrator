import { expect, it, vi } from 'vitest';
import { hasPdfOcrInteriorInk, detectPdfOcrLines, pdfOcrCropExpansion, pdfOcrRecognitionExpansion } from '../../src/lib/pdf-ocr-detector.js';

it('expands clipped glyphs only to the next blank edge within the available context', () => {
  const width=60,height=50,data=new Uint8ClampedArray(width*height*4).fill(255);
  const ink=(x,y)=>data.fill(0,(y*width+x)*4,(y*width+x)*4+3);
  expect(pdfOcrCropExpansion({data,width,height})).toEqual([0,0,0,0]);
  for(let x=7;x<=10;x++)ink(x,20);
  for(let y=6;y<=10;y++)ink(20,y);
  for(let x=49;x<60;x++)ink(x,25);
  for(let y=39;y<=42;y++)ink(30,y);
  ink(20,2); // A separate neighbouring line beyond the blank gap must stay out.
  expect(pdfOcrCropExpansion({data,width,height})).toEqual([4,5,10,4]);
});

it.each([false,true])('keeps separated neighboring-row ink out of vertical expansion (bottom=%s)', bottom => {
  const width=60,height=44,data=new Uint8ClampedArray(width*height*4).fill(255);
  const ink=(x,y)=>data.fill(0,(y*width+x)*4,(y*width+x)*4+3);
  const flip=y=>bottom?height-1-y:y;
  // One unrelated descender grazes the recognition edge. Two blank rows then
  // separate it from the detector core, which covers the intended text row.
  for(let y=1;y<=10;y++)ink(20,flip(y));
  for(let y=13;y<=21;y++)for(let x=20;x<40;x++)ink(x,flip(y));
  const core=bottom?{top:height-22,bottom:height-13}:{top:13,bottom:22};
  expect(pdfOcrCropExpansion({data,width,height},core)).toEqual([0,0,0,0]);
});

it('still restores clipped glyph ink connected to the detector core', () => {
  const width=60,height=44,data=new Uint8ClampedArray(width*height*4).fill(255);
  for(let y=6;y<=20;y++)for(let x=20;x<40;x++)data.fill(0,(y*width+x)*4,(y*width+x)*4+3);
  expect(pdfOcrCropExpansion({data,width,height},{top:13,bottom:22})).toEqual([0,5,0,0]);
});

it.each([[255,0],[255,120],[14,153],[117,255]])('separates foreground from background before extending source context (%s/%s)', (background,foreground) => {
  const width=60,height=44,data=new Uint8ClampedArray(width*height*4);
  for(let p=0;p<width*height;p++)data.set([background,background,background,255],p*4);
  expect(pdfOcrCropExpansion({data,width,height})).toEqual([0,0,0,0]);
  const ink=(x,y)=>data.fill(foreground,(y*width+x)*4,(y*width+x)*4+3);
  for(let y=15;y<24;y++)for(let x=22;x<35;x++)ink(x,y);
  // Dark gray UI/paper is a background, even though every RGB channel is<160.
  expect(pdfOcrCropExpansion({data,width,height})).toEqual([0,0,0,0]);
  for(let x=7;x<=10;x++)ink(x,20);
  expect(pdfOcrCropExpansion({data,width,height})).toEqual([4,0,0,0]);
});

it.each([14,117])('preserves the established recognition context while measuring foreground independently (%s)', background => {
  const width=60,height=44,data=new Uint8ClampedArray(width*height*4).fill(background);
  expect(pdfOcrRecognitionExpansion({data,width,height})).toEqual([10,10,10,10]);
  expect(pdfOcrCropExpansion({data,width,height})).toEqual([0,0,0,0]);
});

it.each([[true,200,2],[false,200,3],[true,10,1]])('bounds sparse retries and preserves coverage (%s, %s)', async (retained, outputHeight, expectedCount) => {
  const canvases=[];
  vi.stubGlobal('document',{createElement:()=>{
    const canvas={width:0,height:0,getContext:()=>({drawImage(){},getImageData:()=>({data:new Uint8Array(canvas.width*canvas.height*4)})})};
    canvases.push(canvas); return canvas;
  }});
  const output = rows => {
    const data=new Float32Array(10*outputHeight);
    for(const row of rows)for(let x=2;x<6;x++)data[row*10+x]=0.9;
    return {y:{dims:[1,1,outputHeight,10],data}};
  };
  const session={inputNames:['x'],outputNames:['y'],run:vi.fn()
    .mockResolvedValueOnce(output([2])).mockResolvedValueOnce(output(retained?[2,6]:[4,6]))};
  try {
    const result=await detectPdfOcrLines({width:1280,height:1280},{Tensor:class {}},session);
    expect(result).toHaveLength(expectedCount);
    expect(result.highResolutionRetry).toBe(outputHeight===200?true:undefined);
    expect(session.run).toHaveBeenCalledTimes(outputHeight===200?2:1);
    expect(canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);
  }finally{vi.unstubAllGlobals();}
});

it('routes only empty interiors to ordinary OCR and detects a single interior ink pixel', () => {
  const data = new Uint8ClampedArray(240 * 240 * 4).fill(255);
  data[(100 * 240 + 1) * 4] = 0; // Dark framing is outside the interior.
  expect(hasPdfOcrInteriorInk(data, 0, 0.5)).toBe(false);
  data[(100 * 240 + 60) * 4] = 0;
  expect(hasPdfOcrInteriorInk(data, 0, 0.5)).toBe(true);
  expect(hasPdfOcrInteriorInk(data, 0.5, 1)).toBe(false);
});

it('releases the detector canvas when inference fails', async () => {
  const canvas={width:0,height:0,getContext:()=>({drawImage(){},getImageData:()=>({data:new Uint8Array(32*32*4)})})};
  vi.stubGlobal('document',{createElement:()=>canvas});
  try {
    const failure=new Error('GPU inference failed');
    const session={inputNames:['x'],run:vi.fn().mockRejectedValue(failure)};
    const ort={Tensor:class {}};
    await expect(detectPdfOcrLines({width:32,height:32},ort,session)).rejects.toBe(failure);
    expect([canvas.width,canvas.height]).toEqual([0,0]);
  }finally{vi.unstubAllGlobals();}
});

it.each([
  {dims:[2,1,1,3],data:new Float32Array([0.8,0.8,0.8])},
  {dims:[1,3],data:new Float32Array([0.8,0.8,0.8])},
  {dims:[1,1,1.5,2],data:new Float32Array([0.8,0.8,0.8])},
  {dims:[1,1,0,3],data:new Float32Array(0)},
  ...[NaN,Infinity,-0.1,1.1].map(value=>({dims:[1,1,1,3],data:new Float32Array([value,0.8,0.8])})),
])('rejects malformed detector output and releases its canvas: %j', async output => {
  const canvas={width:0,height:0,getContext:()=>({drawImage(){},getImageData:()=>({data:new Uint8Array(32*32*4)})})};
  vi.stubGlobal('document',{createElement:()=>canvas});
  try {
    const session={inputNames:['x'],outputNames:['y'],run:async()=>({y:output})};
    await expect(detectPdfOcrLines({width:32,height:32},{Tensor:class {}},session)).rejects.toThrow('Invalid detector');
    expect([canvas.width,canvas.height]).toEqual([0,0]);
  }finally{vi.unstubAllGlobals();}
});
it('clamps float32 sigmoid roundoff but rejects larger excursions', async () => {
  const canvas={width:0,height:0,getContext:()=>({drawImage(){},getImageData:()=>({data:new Uint8Array(32*32*4)})})};
  vi.stubGlobal('document',{createElement:()=>canvas});
  try {
    const data=new Float32Array([-(2**(-24)),1+2**(-23),0.8]);
    const session={inputNames:['x'],outputNames:['y'],run:async()=>({y:{dims:[1,1,1,3],data}})};
    await detectPdfOcrLines({width:32,height:32},{Tensor:class {}},session);
    expect([...data].slice(0,2)).toEqual([0,1]);
    for(const value of [-(2**-22),1+2**-22]){
      data[0]=value;
      await expect(detectPdfOcrLines({width:32,height:32},{Tensor:class {}},session)).rejects.toThrow('Invalid detector probability');
    }
  }finally{vi.unstubAllGlobals();}
});

