import { expect, it, vi } from 'vitest';
import { createPdfOcrWorker } from '../../src/lib/pdf-ocr-worker-client.js';

async function setup(createBitmap) {
  const worker = { postMessage: vi.fn(), terminate: vi.fn() };
  const bitmap = { close: vi.fn() };
  const engine = await createPdfOcrWorker({ runtime: { getURL: path => `chrome-extension://test/${path}` },
    createWorker: () => worker, createBitmap: createBitmap || (async () => bitmap) });
  return { engine, worker, bitmap };
}

it('transfers pixels and routes bounded page/crop results without a remote worker', async () => {
  const { engine, worker, bitmap } = await setup();
  const task = engine.recognize({ width: 100, height: 200 });
  await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(1));
  expect(worker.postMessage).toHaveBeenLastCalledWith({ id: 1, method: 'recognize', bitmap,
    mode: 'page', runtimeRoot: 'chrome-extension://test/' }, [bitmap]);
  const result = { data: { blocks: [] } };
  worker.onmessage({ data: { id: 1, result } }); expect(await task).toBe(result);
  const crop = engine.recognize({ width: 100, height: 100 }, { mode: 'crop' });
  await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(2));
  worker.onmessage({ data: { id: 2, error: { name: 'RangeError', message: 'Model is corrupt' } } });
  await expect(crop).rejects.toMatchObject({ name: 'RangeError', message: 'Model is corrupt' });
  engine.terminate(); engine.terminate(); expect(worker.terminate).toHaveBeenCalledOnce();
});

it('rejects overlap and terminates pending work immediately when closed or crashed', async () => {
  const { engine, worker } = await setup();
  const task = engine.recognize({ width: 10, height: 10 });
  await expect(engine.recognize({ width: 10, height: 10 })).rejects.toThrow(/active/);
  await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce());
  const failed = expect(task).rejects.toThrow(/closed/); worker.onerror(); await failed;
  engine.terminate(); expect(worker.terminate).toHaveBeenCalledOnce();
  await expect(engine.recognize({ width: 10, height: 10 })).rejects.toThrow(/closed/);
});

it('closes a bitmap produced after cancellation without posting it to a retired worker', async () => {
  let complete;
  const { engine, worker } = await setup(() => new Promise(resolve => { complete = resolve; }));
  const task = engine.recognize({ width: 10, height: 10 });
  const failed = expect(task).rejects.toThrow(/closed/);
  engine.terminate(); const bitmap = { close: vi.fn() }; complete(bitmap); await failed;
  expect(bitmap.close).toHaveBeenCalledOnce(); expect(worker.postMessage).not.toHaveBeenCalled();
});

it('releases untransferred pixels after serialization errors and permits a new request', async () => {
  const { engine, worker, bitmap } = await setup(); worker.postMessage.mockImplementationOnce(() => { throw new Error('Transfer failed'); });
  await expect(engine.recognize({ width: 10, height: 10 })).rejects.toThrow('Transfer failed');
  expect(bitmap.close).toHaveBeenCalledOnce();
  const task = engine.recognize({ width: 10, height: 10 });
  await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(2));
  worker.onmessage({ data: { id: 2, result: 'recovered' } }); expect(await task).toBe('recovered'); engine.terminate();
});

it('rejects oversized or invalid images before producing a bitmap', async () => {
  const createBitmap = vi.fn(); const { engine } = await setup(createBitmap);
  for (const source of [{ width: 0, height: 10 }, { width: 4000, height: 4000 }, { width: NaN, height: 10 }]) {
    await expect(engine.recognize(source)).rejects.toThrow(/Invalid OCR/);
  }
  await expect(engine.recognize({ width: 10, height: 10 }, { mode: 'arbitrary' })).rejects.toThrow(/Invalid OCR/);
  expect(createBitmap).not.toHaveBeenCalled(); engine.terminate();
});

it('serializes independent whole-line pixels through the same cancelable worker with a tighter bound', async () => {
  const { engine, worker, bitmap } = await setup();
  await expect(engine.recognizeLine({ width: 2048, height: 1024 })).rejects.toThrow('Invalid OCR');
  const task = engine.recognizeLine({ width: 300, height: 60 });
  await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce());
  expect(worker.postMessage.mock.calls[0][0]).toEqual({ id: 1, method: 'recognizeLine', mode: 'page', bitmap, runtimeRoot: 'chrome-extension://test/' });
  await expect(engine.recognize({ width: 50, height: 50 })).rejects.toThrow('active');
  const assertion = expect(task).rejects.toThrow('closed'); engine.terminate(); await assertion;
});
