import { afterEach, expect, it, vi } from 'vitest';
import { createPdfOcr } from '../../src/lib/pdf-ocr.js';
import { createPdfOcrWorker } from '../../src/lib/pdf-ocr-worker-client.js';

const unwarp = vi.hoisted(() => ({ destroy: vi.fn(async () => {}), retry: vi.fn(async () => null) }));
vi.mock('../../src/lib/pdf-ocr-worker-client.js', () => ({ createPdfOcrWorker: vi.fn() }));
vi.mock('../../src/lib/pdf-ocr-unwarp.js', () => ({ createPdfOcrUnwarp: () => unwarp,
  findOcrPaperInPixels: () => ({ left: 0, top: 0, right: 1, bottom: 1 }) }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it.each([false, true])('terminates a worker once across cancellation and repeated close (termination failure: %s)', async failing => {
  const canvas = { getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(240 * 240 * 4) }) }) };
  vi.stubGlobal('document', { createElement: () => canvas });
  const failure = new Error('Worker termination failed');
  const worker = {
    recognize: vi.fn(() => new Promise(() => {})),
    terminate: vi.fn(async () => { if (failing) throw failure; }),
  };
  createPdfOcrWorker.mockResolvedValue(worker);
  const ocr = createPdfOcr({ runtime: { getURL: path => path } });
  const page = { pageNumber: 1, getViewport: () => ({ width: 100, height: 200 }),
    render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }) };
  const failedRead = expect(ocr.recognizePage(page)).rejects.toMatchObject({
    cause: expect.objectContaining({ message: 'PDF OCR has been closed.' }),
  });
  await vi.waitFor(() => expect(worker.recognize).toHaveBeenCalledTimes(1));
  const closing = Promise.all([ocr.destroy(), ocr.destroy()]);
  if (failing) await expect(closing).rejects.toBe(failure);
  else await closing;
  await failedRead;
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(unwarp.destroy).toHaveBeenCalledTimes(1);
  expect(canvas.width * canvas.height).toBe(0);
  await expect(ocr.recognizePage(page)).rejects.toThrow('closed');
});

it('does not repopulate page caches when close wins the final native-text microtask', async () => {
  const canvases=[];
  vi.stubGlobal('document',{createElement:()=>{
    const canvas={width:0,height:0,getContext:()=>({drawImage(){},getImageData:()=>({data:new Uint8ClampedArray(240*240*4).fill(255)})})};
    canvases.push(canvas);return canvas;
  }});
  const worker={recognize:vi.fn(async()=>({data:{blocks:[]}})),terminate:vi.fn(async()=>{})};
  createPdfOcrWorker.mockResolvedValue(worker);
  const ocr=createPdfOcr({runtime:{getURL:path=>path}});
  let closing;
  const page={pageNumber:7,getViewport:()=>({width:100,height:200}),
    render:()=>({promise:Promise.resolve(),cancel:vi.fn()}),
    getTextContent(){
      queueMicrotask(()=>{closing=ocr.destroy();});
      return Promise.resolve({items:[]});
    },
  };
  await expect(ocr.recognizePage(page)).rejects.toMatchObject({cause:expect.objectContaining({message:'PDF OCR has been closed.'})});
  await closing;
  expect(ocr.getItems(7)).toBeUndefined();expect(ocr.hasPage(7)).toBe(false);
  expect(worker.terminate).toHaveBeenCalledTimes(1);expect(unwarp.destroy).toHaveBeenCalledTimes(1);
  expect(canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);
});
