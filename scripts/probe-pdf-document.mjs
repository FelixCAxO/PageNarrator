// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPdfAcceptanceBrowser } from './lib/pdf-acceptance-browser.mjs';

export async function auditPdfDocument(bytes, { engine, onPage = () => {} }) {
  const task = engine.getDocument({ data: bytes });
  const records = [];
  try {
    const document = await task.promise;
    for (let number = 1; number <= document.numPages; number++) {
      let page;
      try {
        page = await document.getPage(number);
        const text = await page.getTextContent(), inspection = await page.inspect();
        await page.ensureFonts?.();
        records.push({ page: number, items: text.items.length, characters: text.items.reduce((sum, item) => sum + item.str.length, 0),
          artworkWarnings: inspection.artworkWarnings || [], decodingWarnings: inspection.decodingWarnings || [],
          unmappedGlyphs: inspection.unmappedGlyphs || 0, unknownType3Glyphs: inspection.unknownType3Glyphs || 0 });
      } catch (error) { records.push({ page: number, error: { code: error.code, message: error.message } }); }
      finally { await page?.cleanup?.(); }
      await onPage(records.at(-1), document.numPages);
    }
    return { pages: document.numPages, failures: records.filter(record => record.error).length,
      unreadablePages: records.filter(record => record.unmappedGlyphs || record.unknownType3Glyphs).map(record => record.page),
      recoveredPages: records.filter(record => record.artworkWarnings?.length).map(record => record.page), records };
  } finally { await task.destroy(); }
}

async function main() {
  const [filename, output = 'artifacts/engines/pdf-document-audit.json', ...extra] = process.argv.slice(2);
  if (!filename || extra.length) throw new Error('Usage: node scripts/probe-pdf-document.mjs <file.pdf> [report.json]');
  if (path.resolve(filename).toLowerCase() === path.resolve(output).toLowerCase()) throw new Error('The report must not overwrite the source PDF.');
  const bytes = new Uint8Array(await readFile(filename)), session = await createPdfAcceptanceBrowser();
  let report;
  try {
    report = await auditPdfDocument(bytes, { engine: session.engine, onPage(record, total) {
      if (record.error || record.artworkWarnings.length || record.unmappedGlyphs || record.unknownType3Glyphs) console.log(JSON.stringify(record));
      if (record.page % 50 === 0) console.log(`Checked ${record.page}/${total} pages`);
    } });
  } finally { await session.dispose(); }
  report.sourceSha256 = createHash('sha256').update(bytes).digest('hex');
  report.scope = 'Every page through the production facade and module worker in Chromium: text decoding, font loading and inspection, not full raster or spoken-audio acceptance.';
  report.integrity = session.integrity();
  report.pass = report.failures === 0 && report.unreadablePages.length === 0 && report.integrity.pass;
  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ pages: report.pages, failures: report.failures, recoveredPages: report.recoveredPages, unreadablePages: report.unreadablePages, pass: report.pass, report: path.resolve(output) }));
  if (!report.pass) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
