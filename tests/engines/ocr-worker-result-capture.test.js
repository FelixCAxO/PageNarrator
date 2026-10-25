import { expect, it } from 'vitest';
import { createOcrWorkerResultCapture, ocrPageResultLines } from '../../scripts/lib/ocr-worker-result-capture.mjs';

it('keeps bare independent-line results out of primary page observations', () => {
  const primary = [], verification = [], capture = createOcrWorkerResultCapture(primary, verification);
  const line = { words: [{ text: 'source' }] }, verified = { blocks: [{ paragraphs: [{ lines: [line] }] }] };
  capture.request({ id: 1, method: 'recognizeLine' });
  capture.receive({ id: 1, result: verified });
  expect(primary).toEqual([]); expect(verification).toEqual([verified]);
  expect(ocrPageResultLines(primary[0])).toEqual([]);
  expect(ocrPageResultLines(verified)).toEqual([]);
  capture.request({ id: 2, method: 'recognize' });
  capture.receive({ id: 2, result: { data: verified } });
  expect(ocrPageResultLines(primary[0])).toEqual([line]);
});

it('associates out-of-order replies with their own request and isolates reused worker IDs', () => {
  const primary = [], verification = [];
  const first = createOcrWorkerResultCapture(primary, verification), second = createOcrWorkerResultCapture(primary, verification);
  first.request({ id: 1, method: 'recognizeLine' }); first.request({ id: 2, method: 'recognize' });
  second.request({ id: 1, method: 'recognize' });
  first.receive({ id: 2, result: { data: { blocks: [] } } });
  second.receive({ id: 1, result: { data: { blocks: [] } } });
  first.receive({ id: 1, result: { blocks: [] } });
  first.receive({ id: 1, result: { blocks: ['duplicate'] } });
  first.request({ id: 3, method: 'recognize' }); first.receive({ id: 3, error: { message: 'failure' } });
  first.receive({ id: 3, result: { data: { blocks: ['late'] } } });
  expect(primary).toEqual([{ data: { blocks: [] } }, { data: { blocks: [] } }]);
  expect(verification).toEqual([{ blocks: [] }]);
});
