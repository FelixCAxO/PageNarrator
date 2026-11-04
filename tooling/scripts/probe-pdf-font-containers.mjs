// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Development FontFace/OTS diagnostics for independently extracted exact font bytes.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
const argument = (name, fallback) => { const at = process.argv.indexOf(name); return at < 0 ? fallback : process.argv[at + 1]; };
const manifestFile = resolve(argument('--manifest', 'artifacts/engines/pdf-2606-fonts/manifest.json'));
const output = resolve(argument('--output', 'artifacts/engines/pdf-2606-fonts/fontface-before.json'));
const manifest = JSON.parse(await readFile(manifestFile)), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fonts = await Promise.all(manifest.map(async item => { const bytes = await readFile(resolve(item.file)); return { family: item.family, bytes: [...bytes], sha256: hash(bytes) }; }));
const messages = [], errors = [], browser = await chromium.launch({ headless: true, args: ['--disable-gpu'] });
let report;
try {
  const page = await browser.newPage(); page.on('console', message => messages.push({ type: message.type(), text: message.text() })); page.on('pageerror', error => errors.push(error.message));
  const cases = await page.evaluate(async fonts => {
    const cases = [];
    for (const item of fonts) {
      let face;
      try {
        face = new FontFace(item.family, Uint8Array.from(item.bytes).buffer); await face.load(); document.fonts.add(face);
        const canvas = document.createElement('canvas'), context = canvas.getContext('2d'); context.font = `20px ${item.family}`;
        context.fillText(String.fromCodePoint(0xf0001), 5, 30); cases.push({ family: item.family, sha256: item.sha256, bytes: item.bytes.length, loaded: true });
      } catch (error) { cases.push({ family: item.family, sha256: item.sha256, bytes: item.bytes.length, loaded: false, error: error.message }); }
      finally { if (face) document.fonts.delete(face); }
    }
    if (document.fonts.size) throw new Error('Font diagnostic leaked loaded faces.'); return cases;
  }, fonts);
  report = { scope: 'Exact extracted font-container FontFace/OTS load and one glyph paint; not page raster acceptance.', cases, messages, errors, remainingFonts: await page.evaluate(() => document.fonts.size) };
} finally { await browser.close(); }
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report));
if (report.cases.some(item => !item.loaded) || errors.length || report.remainingFonts) process.exitCode = 1;
