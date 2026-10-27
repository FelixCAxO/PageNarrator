// The semantic grid defines the oracle before coordinates and PDF drawing order exist.
import { sidenoteReadingOrderPatterns, buildSidenoteReadingOrderPattern } from './sidenote-reading-order-patterns.js';
const LABELS = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'];
const COLUMNS = ['Topic', 'Details', 'Response', 'Review', 'Controls', 'Status'];
const COLORS = ['amber', 'blue', 'coral', 'denim', 'emerald', 'fuchsia'];

export const TABLE_PATTERN_AXES = {
  columns: [2, 3, 4, 6],
  rows: [3, 5],
  shape: ['text', 'number', 'date', 'uniform-wrap', 'uneven-wrap', 'wrapped-label'],
  header: [false, true],
  sparse: [false, true],
  alignment: ['left', 'center', 'right'],
  sourceOrder: ['rows', 'columns', 'reverse', 'shuffled'],
  fragmentation: ['lines', 'words'],
  scale: [0.5, 1, 2],
  source: ['pdf-text', 'ocr-boxes'],
};

export function* tableReadingOrderPatterns() {
  const entries = Object.entries(TABLE_PATTERN_AXES);
  function* expand(index, parameters) {
    if (index === entries.length) {
      yield parameters;
      return;
    }
    const [key, values] = entries[index];
    for (const value of values) yield* expand(index + 1, { ...parameters, [key]: value });
  }
  let ordinal = 0;
  for (const parameters of expand(0, {})) {
    ordinal += 1;
    yield { id: `table-${String(ordinal).padStart(5, '0')}`, family: parameters.shape, parameters };
  }
}

export function buildTableReadingOrderPattern({ parameters: p }, { measureText = (text, height) => text.length * height * 0.5 } = {}) {
  const wrapped = p.shape.includes('wrap');
  const data = Array.from({ length: p.rows }, (_, row) => Array.from({ length: p.columns }, (_, column) => {
    if (p.sparse && row % 2 === 1 && column === 1) return [];
    const label = LABELS[row], color = COLORS[column];
    if (column === 0) return p.shape === 'wrapped-label' ? [label, 'working group'] : [label];
    if (p.shape === 'number') return [String((row + 1) * (column + 2) * 11.5)];
    if (p.shape === 'date') return [`${row + 10} October ${2026 + column}`];
    if (!wrapped) return [`${label} ${color}`];
    const lines = [`${label} ${color} records the`, 'reviewed policy and the', 'agreed process for teams'];
    if (p.shape === 'uneven-wrap' && (row + column) % 2) lines.push('through the next review');
    return lines;
  }));
  const cells = p.header ? [COLUMNS.slice(0, p.columns).map(text => [text]), ...data] : data;
  const scale = p.scale, width = (60 + p.columns * 200) * scale, height = 900 * scale;
  let y = 820;
  const logical = cells.flatMap((row, rowIndex) => {
    const top = y;
    y -= Math.max(...row.map(cell => cell.length), 1) * 17 + 20;
    return row.flatMap((cell, column) => cell.flatMap((str, line) => {
      const lineWidth = measureText(str, 12);
      const columnX = 30 + column * 200;
      const x = columnX + (p.alignment === 'right' ? 175 - lineWidth : p.alignment === 'center' ? (175 - lineWidth) / 2 : 0);
      const words = p.fragmentation === 'words' ? str.split(' ') : [str];
      let cursor = x;
      return words.map((text, fragment) => {
        const partWidth = p.fragmentation === 'words' ? measureText(text, 12) : lineWidth;
        const part = { str: text, x: cursor * scale, y: (top - line * 17) * scale, width: partWidth * scale,
          height: 12 * scale, transform: [1, 0, 0, 1, cursor * scale, (top - line * 17) * scale],
          patternKey: `${rowIndex}/${column}/${line}/${fragment}`, row: rowIndex, column, line };
        cursor += partWidth + measureText(' ', 12);
        return part;
      });
    }));
  });
  // OCR line membership describes a visible cell line, independently of its input order.
  const lineIds = new Map();
  for (const item of logical) {
    const key = `${item.row}/${item.column}/${item.line}`;
    if (!lineIds.has(key)) lineIds.set(key, lineIds.size);
    if (p.source === 'ocr-boxes') item.ocrLine = lineIds.get(key);
  }
  const items = drawingOrder(logical, p.sourceOrder);
  return { cells, items, expectedKeys: logical.map(item => item.patternKey), expectedText: logical.map(item => item.str),
    options: { pageView: [0, 0, width, height] } };
}

function drawingOrder(logical, order) {
  const items = [...logical];
  if (order === 'rows') items.sort((a, b) => b.y - a.y || a.x - b.x);
  if (order === 'columns') items.sort((a, b) => a.column - b.column || b.y - a.y || a.x - b.x);
  if (order === 'reverse') items.reverse();
  if (order === 'shuffled') {
    let seed = 1729;
    for (let index = items.length - 1; index > 0; index -= 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const other = seed % (index + 1);
      [items[index], items[other]] = [items[other], items[index]];
    }
  }
  return items;
}

export const PROSE_PATTERN_AXES = {
  columns: [1, 2, 3, 4], rows: [3, 6, 9], style: ['uniform', 'staggered', 'headings', 'indented'],
  sourceOrder: ['rows', 'columns', 'reverse', 'shuffled'], fragmentation: ['lines', 'words'],
  scale: [0.5, 1, 2], fontHeight: [9, 12, 18],
};

export function* proseReadingOrderPatterns() {
  let ordinal = 0;
  for (const columns of PROSE_PATTERN_AXES.columns) for (const rows of PROSE_PATTERN_AXES.rows)
    for (const style of PROSE_PATTERN_AXES.style) for (const sourceOrder of PROSE_PATTERN_AXES.sourceOrder)
      for (const fragmentation of PROSE_PATTERN_AXES.fragmentation) for (const scale of PROSE_PATTERN_AXES.scale)
        for (const fontHeight of PROSE_PATTERN_AXES.fontHeight) {
          ordinal += 1;
          yield { id: `prose-${String(ordinal).padStart(5, '0')}`, family: `prose-${style}`,
            parameters: { columns, rows, style, sourceOrder, fragmentation, scale, fontHeight, source: 'pdf-text' } };
        }
}

export function buildProseReadingOrderPattern({ parameters: p }, { measureText = (text, height) => text.length * height * 0.5 } = {}) {
  const columns = Array.from({ length: p.columns }, (_, column) => [
    ...(p.style === 'headings' ? [`${COLUMNS[column]} overview`] : []),
    ...Array.from({ length: p.rows }, (_, line) => [
      `The ${COLORS[column]} team reviewed ${LABELS[Math.floor(line / 3)].toLowerCase()}`,
      `and ${COLORS[column]} working procedures`,
      `before ${COLORS[column]} reviewers proceed.`,
    ][line % 3]),
  ]);
  const logical = columns.flatMap((lines, column) => lines.flatMap((str, line) => {
    const x = 30 + column * 360 + (p.style === 'indented' && line % 3 === 1 ? 12 : 0);
    const y = 820 - line * p.fontHeight * 1.4 - (p.style === 'staggered' ? column * 5 : 0)
      - (p.style === 'headings' && line ? p.fontHeight : 0);
    let cursor = x;
    return (p.fragmentation === 'words' ? str.split(' ') : [str]).map((text, fragment) => {
      const width = measureText(text, p.fontHeight);
      const part = { str: text, x: cursor * p.scale, y: y * p.scale, width: width * p.scale,
        height: p.fontHeight * p.scale, transform: [1, 0, 0, 1, cursor * p.scale, y * p.scale],
        patternKey: `${column}/${line}/${fragment}`, column };
      cursor += width + measureText(' ', p.fontHeight);
      return part;
    });
  }));
  return { cells: columns, items: drawingOrder(logical, p.sourceOrder), expectedKeys: logical.map(item => item.patternKey),
    expectedText: logical.map(item => item.str), options: { pageView: [0, 0, (60 + p.columns * 360) * p.scale, 900 * p.scale] } };
}

export function* readingOrderPatterns() { yield* tableReadingOrderPatterns(); yield* proseReadingOrderPatterns(); yield* sidenoteReadingOrderPatterns(); }
export function buildReadingOrderPattern(pattern, options) {
  if (pattern.id.startsWith('sidenote-')) return buildSidenoteReadingOrderPattern(pattern, options);
  return pattern.id.startsWith('table-') ? buildTableReadingOrderPattern(pattern, options) : buildProseReadingOrderPattern(pattern, options);
}
