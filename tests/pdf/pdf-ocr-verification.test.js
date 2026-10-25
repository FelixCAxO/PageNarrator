import {afterEach,expect,it,vi} from 'vitest';
import {createPdfOcr} from '../../src/lib/pdf-ocr.js';
import {createPdfOcrWorker} from '../../src/lib/pdf-ocr-worker-client.js';
const recognizeCrop = vi.hoisted(() => vi.fn(async () => null));
vi.mock('../../src/lib/pdf-ocr-worker-client.js',()=>({createPdfOcrWorker:vi.fn()}));
vi.mock('../../src/lib/pdf-ocr-unwarp.js',()=>({
  findOcrPaperInPixels:()=>({left:0,top:0,right:1,bottom:1}),
  createPdfOcrUnwarp:()=>({destroy:async()=>{},recognizeCrop,retry:async()=>[{
    bbox:{x0:0,y0:0,x1:50,y1:20},words:[{text:'goa/s',confidence:97,bbox:{x0:0,y0:0,x1:50,y1:20}}],
  }]}),
}));
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();recognizeCrop.mockImplementation(async()=>null);vi.useRealTimers();});
it.each(['startup','recognition'])('retains neural text if optional source-crop retry fails at %s',async stage=>{
  vi.stubGlobal('navigator',{gpu:{}});
  vi.stubGlobal('document',{createElement:()=>({width:0,height:0,getContext:()=>({
    drawImage(){},getImageData:()=>({data:new Uint8ClampedArray(240*240*4)}),
  })})});
  const failure=new Error('CPU unavailable');
  if(stage==='startup')createPdfOcrWorker.mockRejectedValue(failure);
  else createPdfOcrWorker.mockResolvedValue({recognize:vi.fn().mockRejectedValue(failure),terminate:async()=>{}});
  const reader=createPdfOcr({runtime:{getURL:path=>path}});
  const page={pageNumber:1,getViewport:({scale})=>({width:100*scale,height:200*scale,
    convertToPdfPoint:(x,y)=>[x/scale,y/scale]}),render:()=>({promise:Promise.resolve()})};
  try{
    expect((await reader.recognizePage(page)).map(item=>item.str)).toEqual(['goa/s']);
    expect((await reader.recognizePage({...page,pageNumber:2})).map(item=>item.str)).toEqual(['goa/s']);
    expect(createPdfOcrWorker).toHaveBeenCalledTimes(2);
  }
  finally{await reader.destroy();}
});

it('ignores a retired source retry failure after the next page has a fresh worker', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('navigator', { gpu: {} });
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({
    drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(240 * 240 * 4) }),
  }) }) });
  let rejectRetired, completeFresh;
  const retired = { recognize: vi.fn(() => new Promise((resolve, reject) => { rejectRetired = reject; })), terminate: vi.fn(async () => {}) };
  const fresh = { recognize: vi.fn(() => new Promise(resolve => { completeFresh = resolve; })), terminate: vi.fn(async () => {}) };
  createPdfOcrWorker.mockResolvedValueOnce(retired).mockResolvedValue(fresh);
  const reader = createPdfOcr({ runtime: { getURL: path => path } });
  const page = pageNumber => ({ pageNumber, getViewport: ({ scale }) => ({ width: 100 * scale, height: 200 * scale,
    convertToPdfPoint: (x, y) => [x / scale, y / scale] }), render: () => ({ promise: Promise.resolve() }) });
  const deadline = expect(reader.recognizePage(page(1))).rejects.toMatchObject({
    cause: expect.objectContaining({ message: 'PDF OCR timed out.' }),
  });
  await vi.advanceTimersByTimeAsync(90_000);
  await deadline;
  const second = reader.recognizePage(page(2));
  await vi.waitFor(() => expect(completeFresh).toBeTypeOf('function'));
  rejectRetired(new Error('Retired verification failed'));
  await vi.advanceTimersByTimeAsync(0);
  expect(fresh.terminate).not.toHaveBeenCalled();
  completeFresh({ data: { blocks: [] } });
  expect((await second).map(item => item.str)).toEqual(['goa/s']);
  fresh.recognize.mockResolvedValue({ data: { blocks: [] } });
  expect((await reader.recognizePage(page(3))).map(item => item.str)).toEqual(['goa/s']);
  expect(createPdfOcrWorker).toHaveBeenCalledTimes(2);
  await reader.destroy();
});

it.each(['accepted', 'coverage', 'empty', 'unavailable'])('keeps crop geometry and coverage policy with cached GPU %s', async state => {
  vi.stubGlobal('navigator', { gpu: {} });
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({
    drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(240 * 240 * 4) }),
  }) }) });
  const makeResult = text => ({ data: { blocks: [{ paragraphs: [{ lines: text ? [{
    bbox: { x0: 0, y0: 0, x1: 75, y1: 30 }, words: [
      { text, confidence: 99, bbox: { x0: 0, y0: 0, x1: 75, y1: 30 } },
    ],
  }] : [] }] }] } });
  const cpuCalls = [], gpuCalls = [];
  const worker = { recognize: vi.fn(async (canvas, options) => {
    cpuCalls.push({ canvas, dimensions: [canvas.width, canvas.height], options });
    return makeResult('goals');
  }), terminate: vi.fn(async () => {}) };
  createPdfOcrWorker.mockResolvedValue(worker);
  recognizeCrop.mockImplementation(async (canvas, pendingWorker) => {
    gpuCalls.push({ canvas, dimensions: [canvas.width, canvas.height], worker: await pendingWorker });
    return state === 'unavailable' ? null : makeResult(state === 'accepted' ? 'goals' : state === 'coverage' ? 'bad' : null);
  });
  const render = vi.fn(() => ({ promise: Promise.resolve() }));
  const page = { pageNumber: 1, getViewport: ({ scale }) => ({ width: 100 * scale, height: 200 * scale,
    convertToPdfPoint: (x, y) => [x / scale, y / scale] }), render };
  const reader = createPdfOcr({ runtime: { getURL: path => path } });
  try {
    const items = await reader.recognizePage(page);
    expect(items.map(item => item.str)).toEqual([['accepted', 'unavailable'].includes(state) ? 'goals' : 'goa/s']);
    expect(items[0]).toMatchObject({ width: 50 / 3, height: 20 / 3,
      transform: [20 / 3, 0, 0, 20 / 3, 0, 20 / 3] });
    expect(recognizeCrop).toHaveBeenCalledTimes(1); expect(gpuCalls[0].dimensions).toEqual([105, 60]);
    expect(gpuCalls[0].worker).toBe(worker);
    expect(render).toHaveBeenCalledTimes(3);
    expect(render.mock.calls[2][0]).toMatchObject({ viewport: { width: 450, height: 900 }, transform: [1, 0, 0, 1, -0, -0] });
    expect(worker.recognize).toHaveBeenCalledTimes(state === 'unavailable' ? 1 : 0);
    if (state === 'unavailable') expect(cpuCalls[0]).toEqual({ canvas: gpuCalls[0].canvas, dimensions: [105, 60], options: { mode: 'crop' } });
    expect([gpuCalls[0].canvas.width, gpuCalls[0].canvas.height]).toEqual([0, 0]);
  } finally { await reader.destroy(); }
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});
