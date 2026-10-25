import { expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';

// Original CID CFF: 65,535 empty glyphs, a single FD, and one bounded CID range.
// It exercises the legal glyph-count boundary without retained third-party font data.
const join = parts => new Uint8Array(Buffer.concat(parts.map(part => Buffer.from(part))));
const integer = n => Uint8Array.of(29, n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255);
const dict = (values, op) => join([...values.map(integer), Uint8Array.from(op)]);
function index(parts) {
  if (!parts.length) return Uint8Array.of(0, 0);
  const offsets = [1]; for (const part of parts) offsets.push(offsets.at(-1) + part.length);
  const size = offsets.at(-1) <= 255 ? 1 : offsets.at(-1) <= 65535 ? 2 : 3;
  return join([Uint8Array.of(parts.length >> 8, parts.length & 255, size),
    Uint8Array.from(offsets.flatMap(value => Array.from({ length: size }, (_, i) => value >> (size - 1 - i) * 8 & 255))), ...parts]);
}
function maximumGlyphCff() {
  const header = Uint8Array.of(1, 0, 4, 4), names = index([Buffer.from('OwnMaximumGlyphs')]);
  const strings = index([Buffer.from('Adobe'), Buffer.from('Identity')]), globals = index([]);
  const charset = Uint8Array.of(2, 0, 1, 255, 253), glyphs = index(Array.from({ length: 65535 }, () => Uint8Array.of(14)));
  const selection = Uint8Array.of(3, 0, 1, 0, 0, 0, 255, 255), dictionaries = index([new Uint8Array()]);
  const top = (charsetAt, glyphsAt, selectionAt, dictionariesAt) => join([dict([391, 392, 0], [12, 30]),
    dict([charsetAt], [15]), dict([glyphsAt], [17]), dict([selectionAt], [12, 37]), dict([dictionariesAt], [12, 36])]);
  const start = header.length + names.length + index([top(0, 0, 0, 0)]).length + strings.length + globals.length;
  return join([header, names, index([top(start, start + charset.length, start + charset.length + glyphs.length,
    start + charset.length + glyphs.length + selection.length)]), strings, globals, charset, glyphs, selection, dictionaries]);
}

it('builds the maximum legal CFF glyph metrics in a worker with a constrained argument stack', async () => {
  const fontUrl = new URL('../../src/pdf/cff-font.js', import.meta.url).href;
  const containerUrl = new URL('../../src/pdf/font-container.js', import.meta.url).href;
  const metricsUrl = new URL('../../src/pdf/font-metrics.js', import.meta.url).href;
  const source = `const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { parseCffFont } = await import(${JSON.stringify(fontUrl)});
      const { buildCffOpenType } = await import(${JSON.stringify(containerUrl)});
      const { readTrueTypeMetrics } = await import(${JSON.stringify(metricsUrl)});
      const font = parseCffFont(workerData), widths = Array(font.glyphs.length).fill(600);
      widths[0] = -139; widths[2] = 65535;
      const converted = buildCffOpenType(font, widths), metrics = readTrueTypeMetrics(converted);
      const view = new DataView(converted.buffer); let maximum;
      for (let i = 0; i < view.getUint16(4); i++) {
        const row = 12 + i * 16;
        if (new TextDecoder().decode(converted.subarray(row, row + 4)) === 'hhea') maximum = view.getUint16(view.getUint32(row + 8) + 10);
      }
      parentPort.postMessage({ glyphs: metrics.glyphCount, maximum, first: metrics.widthByGlyph(0),
        widest: metrics.widthByGlyph(2), last: metrics.widthByGlyph(65534), originalFirst: widths[0] });
    })().catch(error => { throw error; });`;
  const worker = new Worker(source, { eval: true, workerData: maximumGlyphCff(), resourceLimits: { stackSizeMb: .5 } });
  try {
    const result = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); worker.once('exit', code => { if (code) reject(new Error('Metric worker exited ' + code)); }); });
    expect(result).toEqual({ glyphs: 65535, maximum: 65535, first: 0, widest: 65535, last: 600, originalFirst: -139 });
  } finally { await worker.terminate(); }
});
