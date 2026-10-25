import { expect, it, vi } from 'vitest';
import { recognizePdfOcrNeuralLines } from '../../src/lib/pdf-ocr-neural-batch.js';
const crop = (width, height) => ({ width, height, getContext: () => ({ getImageData: () => ({ width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) }) }) });
it('decodes each batch row with its own crop geometry and rejects oversized batches', async () => {
  const canvases = [];
  vi.stubGlobal('document', { createElement: () => {
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {}, getImageData: () => ({data: new Uint8Array(canvas.width * canvas.height * 4)}) }) };
    canvases.push(canvas); return canvas;
  } });
  try {
    const ort = { Tensor: class { constructor(type, data, dims) { Object.assign(this, {type,data,dims}); } } };
    const session = { inputNames: ['x'], run: vi.fn(async ({x}) => {
      expect(x.dims).toEqual([2,3,48,320]);
      return {ocr_spaces:{dims:[2,2],data:new Float32Array(4)},ocr_labels:{dims:[2,2],data:BigInt64Array.from([1n,0n,2n,0n])},ocr_scores:{dims:[2,2],data:Float32Array.from([.9,1,.8,1])}};
    }) };
    const result = await recognizePdfOcrNeuralLines([crop(68,68),crop(44,68)],ort,session,['','a','b',' ']);
    const lines = result.map(r=>r.blocks[0].paragraphs[0].lines[0]);
    expect(lines.map(l=>l.words[0].text)).toEqual(['a','b']);
    expect(lines.map(l=>l.bbox.x1)).toEqual([58,34]);
    expect(canvases.every(c=>c.width===0&&c.height===0)).toBe(true);
    await expect(recognizePdfOcrNeuralLines([{}, {}, {}],ort,session,[])).rejects.toThrow('batch size');
    session.run.mockResolvedValue({ocr_labels:{dims:[1,4],data:BigInt64Array.from([1n,0n,2n,0n])},ocr_scores:{dims:[1,4],data:Float32Array.from([.9,1,.8,1])}});
    await expect(recognizePdfOcrNeuralLines([{width:68,height:68},{width:44,height:68}],ort,session,['','a','b',' '])).rejects.toThrow('Invalid OCR batch output');

  } finally { vi.unstubAllGlobals(); }
});

it('recovers spaces only from blank positions and rejects malformed space output', async () => {
  vi.stubGlobal('document',{createElement:()=>{
    const canvas={width:0,height:0,getContext:()=>({drawImage(){},getImageData:()=>({data:new Uint8Array(canvas.width*canvas.height*4)})})};
    return canvas;
  }});
  try {
    const ort={Tensor:class {}};
    const output=()=>({ocr_labels:{dims:[1,3],data:BigInt64Array.from([1n,0n,2n])},ocr_scores:{dims:[1,3],data:Float32Array.from([.99,.7,.99])},ocr_spaces:{dims:[1,3],data:Float32Array.from([.3,.25,.3])}});
    const session={inputNames:['x'],run:vi.fn()};
    const run=()=>recognizePdfOcrNeuralLines([crop(340,68)],ort,session,['','a','b',' ']);
    session.run.mockResolvedValue(output());
    expect((await run())[0].blocks[0].paragraphs[0].lines[0].words.map(w=>w.text)).toEqual(['a','b']);
    const bounded=await recognizePdfOcrNeuralLines([crop(340,68)],ort,session,['','a','b',' '],[{left:0,right:100}]);
    expect(bounded[0].blocks[0].paragraphs[0].lines[0].words.map(w=>w.text)).toEqual(['a']);
    for(const bounds of [[],[{left:-1,right:100}],[{left:0,right:341}],[{left:100,right:100}]]) {
      await expect(recognizePdfOcrNeuralLines([crop(340,68)],ort,session,['','a','b',' '],bounds)).rejects.toThrow('Invalid OCR source extent');
    }
    const low=output();low.ocr_spaces.data[1]=.249;
    session.run.mockResolvedValue(low);
    expect((await run())[0].blocks[0].paragraphs[0].lines[0].words.map(w=>w.text)).toEqual(['ab']);
    for(const bad of [undefined,{dims:[3,1],data:new Float32Array(3)},{dims:[1,3],data:new Float32Array(2)},...[NaN,Infinity,-.1,1.1].map(value=>({dims:[1,3],data:Float32Array.from([0,value,0])}))]){
      session.run.mockResolvedValue({...output(),ocr_spaces:bad});
      await expect(run()).rejects.toThrow('Invalid OCR space');
    }
  } finally {vi.unstubAllGlobals();}
});

it('keeps exact model input bytes when source-only foreground geometry is supplied', async () => {
  vi.stubGlobal('document',{createElement:()=>{
    const canvas={width:0,height:0,getContext:()=>({drawImage(){},getImageData:()=>({data:Uint8Array.from({length:canvas.width*canvas.height*4},(_,i)=>i%251)})})};return canvas;
  }});
  try{
    const feeds=[],ort={Tensor:class{constructor(type,data,dims){Object.assign(this,{type,data,dims});}}};
    const session={inputNames:['x'],run:vi.fn(async({x})=>{
      feeds.push({dims:x.dims,bits:Array.from(new Uint32Array(x.data.buffer,x.data.byteOffset,x.data.length))});
      return{ocr_labels:{dims:[1,16],data:BigInt64Array.from({length:16},(_,i)=>i===5?1n:0n)},ocr_scores:{dims:[1,16],data:new Float32Array(16).fill(.99)},ocr_spaces:{dims:[1,16],data:new Float32Array(16)}};
    })};
    const input=[crop(340,68)],alphabet=['','a',' '];
    const before=await recognizePdfOcrNeuralLines(input,ort,session,alphabet,[{left:0,right:340}]);
    const after=await recognizePdfOcrNeuralLines(input,ort,session,alphabet,[{left:0,right:340,wordTop:20,wordBottom:48}]);
    expect(feeds[1]).toEqual(feeds[0]);
    expect(after[0].blocks[0].paragraphs[0].lines[0].words.map(w=>[w.text,w.confidence])).toEqual(before[0].blocks[0].paragraphs[0].lines[0].words.map(w=>[w.text,w.confidence]));
    for(const bounds of[{wordTop:-1,wordBottom:48},{wordTop:40,wordBottom:20},{wordTop:20,wordBottom:69},{wordTop:NaN,wordBottom:48}]){
      await expect(recognizePdfOcrNeuralLines(input,ort,session,alphabet,[{left:0,right:340,...bounds}])).rejects.toThrow('source word frame');
    }
    expect(session.run).toHaveBeenCalledTimes(2);
  }finally{vi.unstubAllGlobals();}
});

it('carries actual horizontal source context through the neural geometry adapter without changing model feeds',async()=>{
  vi.stubGlobal('document',{createElement:()=>{
    const canvas={width:0,height:0,getContext:()=>({drawImage(){},getImageData:()=>({data:new Uint8Array(canvas.width*canvas.height*4).fill(255)})})};return canvas;
  }});
  try{
    const image={width:100,height:50,data:new Uint8ClampedArray(100*50*4).fill(255)};
    const ink=(left,top,right,bottom)=>{for(let y=top;y<bottom;y++)for(let x=left;x<right;x++)image.data.set([0,0,0,255],(y*100+x)*4);};
    ink(6,18,25,21);ink(13,21,18,33);ink(30,18,38,33);
    const source={width:100,height:50,getContext:()=>({getImageData:()=>image})},feeds=[];
    const ort={Tensor:class{constructor(type,data,dims){Object.assign(this,{type,data,dims});}}};
    const session={inputNames:['x'],run:async({x})=>{
      feeds.push(Array.from(new Uint32Array(x.data.buffer,x.data.byteOffset,x.data.length)));
      return{ocr_labels:{dims:[1,16],data:BigInt64Array.from({length:16},(_,i)=>i===1?1n:i===2?2n:0n)},
        ocr_scores:{dims:[1,16],data:new Float32Array(16).fill(.99)},ocr_spaces:{dims:[1,16],data:new Float32Array(16)}};
    }};
    const run=extent=>recognizePdfOcrNeuralLines([source],ort,session,['','T','a',' '],[extent]);
    const before=(await run({left:0,right:100}))[0].blocks[0].paragraphs[0].lines[0].words[0];
    const after=(await run({left:0,right:100,wordTop:10,wordBottom:40}))[0].blocks[0].paragraphs[0].lines[0].words[0];
    expect(before.bbox).toEqual({x0:29,y0:17,x1:39,y1:34});
    expect(after).toEqual({...before,bbox:{x0:5,y0:17,x1:39,y1:34}});
    expect(feeds[1]).toEqual(feeds[0]);
  }finally{vi.unstubAllGlobals();}
});
