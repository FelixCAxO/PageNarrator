import { expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createPdfPageModel } from '../../src/lib/pdf-page-model.js';
import { configurePdfWorker, extractPdfTextFromData } from '../../src/lib/pdf-extraction.js';
import { buildPdfBytes } from '../helpers/pdf-test-generator.js';
import { DEADLINE_ROWS, tablePdfItems, WRAPPED_SWEDISH_ROWS, wrappedSwedishTableItems } from '../fixtures/reading-order-fixtures.js';

configurePdfWorker(pdfjs);

it.each([0.5, 1, 2])('finishes wrapped prose cells in the narrow-gutter Swedish table at scale %s', (scale) => {
  const model = createPdfPageModel(wrappedSwedishTableItems({ scale }), { pageView: [0, 0, 856 * scale, 792 * scale] });
  expect(model.orderedItems.map(({ str }) => str)).toEqual(WRAPPED_SWEDISH_ROWS.flat(2));
});

it.each([false, true])('keeps every wrapped line in its table cell with OCR=%s', (ocr) => {
  // A wider gutter isolates wrapped-cell grouping from the narrow-gutter case.
  const model = createPdfPageModel(wrappedSwedishTableItems({ gutter: 50, ocr }), { pageView: [0, 0, 906, 792] });
  expect(model.orderedItems.map(({ str }) => str)).toEqual(WRAPPED_SWEDISH_ROWS.flat(2));
});

it('repairs column-major OCR order in the narrow-gutter Swedish table', () => {
  const model = createPdfPageModel(wrappedSwedishTableItems({ ocr: true }), { pageView: [0, 0, 856, 792] });
  expect(model.orderedItems.map(({ str }) => str)).toEqual(WRAPPED_SWEDISH_ROWS.flat(2));
});

it.each([false, true])('reads fragmented wrapped table cells with small position errors and OCR=%s', (ocr) => {
  const items = wrappedSwedishTableItems({ ocr }).flatMap((item, line) => {
    const words = item.str.split(' ');
    const unit = (item.width - (words.length - 1) * 4) / words.join('').length;
    let x = item.x + (line % 3 - 1);
    return words.map((str, word) => {
      const width = str.length * unit;
      const y = item.y + (word % 3 - 1) * 0.5;
      const part = { ...item, str, x, y, width, transform: [1, 0, 0, 1, x, y] };
      x += width + 4;
      return part;
    });
  });
  const model = createPdfPageModel(items, { pageView: [0, 0, 856, 792] });
  expect(model.orderedItems.map(({ str }) => str)).toEqual(WRAPPED_SWEDISH_ROWS.flat(2).flatMap((line) => line.split(' ')));
});

it('keeps asymmetric prose columns with compact headings in column order', () => {
  const columns = [
    ['Overview', 'The team reviewed the existing process', 'and documented how information moves',
      'between the different departments.', 'These observations explain the current', 'working practices and their limitations.'],
    ['Findings', 'The review identified several practical', 'improvements that need careful planning',
      'before the team can adopt them.', 'Each department needs enough time', 'to discuss the proposed changes',
      'and test them in ordinary work.', 'The report describes these next steps.'],
  ];
  const items = columns.flatMap((column, index) => column.map((str, line) => {
    const x = 30 + index * 285;
    const y = 700 - line * 16 - (line ? 8 : 0);
    return { str, x, y, width: str.length * 6, height: 12, transform: [1, 0, 0, 1, x, y] };
  })).sort((a, b) => b.y - a.y || a.x - b.x);
  const model = createPdfPageModel(items, { pageView: [0, 0, 612, 792] });
  expect(model.orderedItems.map(({ str }) => str)).toEqual(columns.flat());
  expect(model.lines.some(({ role }) => role === 'table-row')).toBe(false);
});

it.each([false, true])('keeps a following section outside the wrapped table with OCR=%s', (ocr) => {
  const after = ['Next section', 'The next section explains how to evaluate the findings across the entire organisation.'];
  const items = wrappedSwedishTableItems({ ocr });
  items.push(...after.map((str, index) => ({
    str, x: 27, y: 508 - index * 22, width: index ? 770 : 130, height: 20,
    transform: [1, 0, 0, 1, 27, 508 - index * 22], ...(ocr ? { ocrLine: items.length + index } : {}),
  })));
  const model = createPdfPageModel(items, { pageView: [0, 0, 856, 792] });
  expect(model.orderedItems.map(({ str }) => str)).toEqual([...WRAPPED_SWEDISH_ROWS.flat(2), ...after]);
  const followingLines = model.lines.filter(({ parts }) => parts.some(({ str }) => after.includes(str)));
  expect(followingLines.length).toBeGreaterThan(0);
  expect(followingLines.every(({ role }) => role !== 'table-row')).toBe(true);
});

it('reads a compact table after the wrapped table without changing either table order', () => {
  const compact = [['Task', 'Owner'], ['Design', 'Alice'], ['Review', 'Bob']];
  const following = tablePdfItems(compact, { top: 470, rowGap: 44 }).map((item, index) => {
    const x = index % 2 ? 237 : 27;
    return { ...item, x, height: 20, transform: [1, 0, 0, 1, x, item.y] };
  });
  const model = createPdfPageModel([...wrappedSwedishTableItems(), ...following], { pageView: [0, 0, 856, 792] });
  expect(model.orderedItems.map(({ str }) => str)).toEqual([...WRAPPED_SWEDISH_ROWS.flat(2), ...compact.flat()]);
  expect(model.lines.every(({ role }) => role === 'table-row')).toBe(true);
});

it('preserves wrapped prose cell order through real PDF decoding and speech chunking', async () => {
  const result = await extractPdfTextFromData(buildPdfBytes(wrappedSwedishTableItems(), { width: 856 }), { pdfjs });
  const speech = result.chunks.map(({ speech: text }) => text).join(' ');
  let cursor = -1;
  for (const line of WRAPPED_SWEDISH_ROWS.flat(2)) {
    const position = speech.indexOf(line, cursor + 1);
    expect(position, `Missing or out-of-order cell line: ${line}\n${speech}`).toBeGreaterThan(cursor);
    cursor = position;
  }
});

it.each([0.5, 1, 2])('reads the text/date deadline table row by row at scale %s', (scale) => {
  const items = tablePdfItems(undefined, { scale });
  // PDF drawing order can be column-major even when the visual table is row-major.
  const model = createPdfPageModel([...items].sort((a, b) => a.x - b.x || a.y - b.y), { pageView: [0, 0, 1000 * scale, 792 * scale] });
  expect(model.orderedItems.map(({ str }) => str)).toEqual(DEADLINE_ROWS.flat());
  expect(model.lines.every(({ role }) => role === 'table-row')).toBe(true);
});

it.each([
  { rows: [['Task', 'Owner'], ['Design', 'Alice'], ['Review', 'Bob'], ['Release', 'Clara']] },
  { rows: [['Plan', 'Status', 'Notes'], ['Starter', 'Active', 'Ready'], ['Growth', 'Pending', 'Needs review']] },
])('recognizes text-only tables without requiring a numeric cell', ({ rows }) => {
  const model = createPdfPageModel(tablePdfItems(rows), { pageView: [0, 0, 1000, 792] });
  expect(model.orderedItems.map(({ str }) => str)).toEqual(rows.flat());
  expect(model.lines.every(({ role }) => role === 'table-row')).toBe(true);
});

it('finishes each wrapped cell before moving across the row', () => {
  const rows = [['Task', 'Due', 'Notes'], ['Iteration two', '5 October', 'Send the source'], ['Iteration three', '16 October', 'Await feedback']];
  const items = tablePdfItems(rows, { rowGap: 50 });
  items.push(...tablePdfItems([['and its PDF', '', 'and the report']], { top: 633 }).filter(({ str }) => str));
  const model = createPdfPageModel(items, { pageView: [0, 0, 1000, 792] });
  expect(model.orderedItems.map(({ str }) => str)).toEqual([
    ...rows[0], 'Iteration two', 'and its PDF', '5 October', 'Send the source', 'and the report', ...rows[2],
  ]);
});

it('recognizes right-aligned table cells of different widths', () => {
  const rows = [['Item', 'Quantity', 'Total'], ['Books', '12', '120'], ['Pens', '5000', '25000']];
  const items = tablePdfItems(rows).map((item, index) => index % 3
    ? { ...item, transform: [1, 0, 0, 1, item.x + 100 - item.width, item.y] } : item);
  const model = createPdfPageModel(items);
  expect(model.orderedItems.map(({ str }) => str)).toEqual(rows.flat());
  expect(model.lines.every(({ role }) => role === 'table-row')).toBe(true);
});

it('keeps sparse rows inside a table without shifting its remaining cells', () => {
  const rows = [['Task', 'Due', 'Feedback'], ['Alpha', '', 'Friday'], ['Beta', 'Monday', '']];
  const items = tablePdfItems(rows).filter(({ str }) => str);
  const model = createPdfPageModel(items);
  expect(model.orderedItems.map(({ str }) => str)).toEqual(rows.flat().filter(Boolean));
  expect(model.lines.every(({ role }) => role === 'table-row')).toBe(true);
});

it('keeps prose column order between two separate tables', () => {
  const top = [['Task', 'Owner'], ['Design', 'Alice'], ['Review', 'Bob']];
  const bottom = [['Plan', 'Status'], ['Starter', 'Active'], ['Growth', 'Pending']];
  const prose = tablePdfItems([['Left first.', 'Right first.'], ['Left last.', 'Right last.']], { top: 510, rowGap: 20 });
  const model = createPdfPageModel([...tablePdfItems(top), ...prose, ...tablePdfItems(bottom, { top: 410 })]);
  expect(model.orderedItems.map(({ str }) => str)).toEqual([
    ...top.flat(), 'Left first.', 'Left last.', 'Right first.', 'Right last.', ...bottom.flat(),
  ]);
});

it('does not turn prose beside chart axes into a sparse numeric table', () => {
  const rows = [
    ['An opening prose line continues', '1.2', 'Human', 'Model'],
    ['with another prose line here.', '0.8', '', ''],
    ['and the final sentence below.', '0.6', '', ''],
  ];
  const model = createPdfPageModel(tablePdfItems(rows, { rowGap: 30 }).filter(({ str }) => str));
  expect(model.lines.some(({ role }) => role === 'table-row')).toBe(false);
  expect(model.orderedItems.slice(0, 3).map(({ str }) => str)).toEqual(rows.map((row) => row[0]));
});

it('repairs column-major OCR cell order for a confidently detected table', () => {
  const items = tablePdfItems().sort((a, b) => a.x - b.x || b.y - a.y)
    .map((part, ocrLine) => ({ ...part, ocrLine }));
  expect(createPdfPageModel(items).orderedItems.map(({ str }) => str)).toEqual(DEADLINE_ROWS.flat());
});

it('preserves row order through real PDF decoding and speech chunking', async () => {
  const items = tablePdfItems().sort((a, b) => a.x - b.x || a.y - b.y);
  const result = await extractPdfTextFromData(buildPdfBytes(items, { width: 1000 }), { pdfjs });
  const speech = result.chunks.map(({ speech }) => speech).join(' ');
  let cursor = -1;
  for (const cell of DEADLINE_ROWS.flat()) {
    const position = speech.indexOf(cell, cursor + 1);
    expect(position, `Missing or out-of-order cell: ${cell}\n${speech}`).toBeGreaterThan(cursor);
    cursor = position;
  }
});
