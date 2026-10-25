// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Independent private reference construction. Never import the product PDF parser or narration model.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { publicPdfLibraryManifest } from './lib/pdf-library-public-manifest.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const tokens = value => String(value).normalize('NFKD').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
const key = value => tokens(value).join(' ');
// Word boundaries may be inferred differently by layout and word extractors.
// Use only complete spans for physical-furniture identity, never prefixes.
const furnitureKey = value => tokens(value).join('');
function canonicalFurnitureText(value, page) {
  const matches = [...new Set(String(page.layoutText || '').split(/\r?\n/u).map(line => line.trim())
    .filter(line => line && furnitureKey(line) === furnitureKey(value)))];
  return matches.length === 1 ? matches[0] : value;
}

function sourceWordRows(page, { byBottom = false, splitGaps = false } = {}) {
  const rows = [], coordinate = byBottom ? 'bottom' : 'top';
  for (const word of [...(page.rawWords || [])].sort((a, b) => a[coordinate] - b[coordinate] || a.x0 - b.x0)) {
    let row = rows.find(other => Math.abs(other.coordinate - word[coordinate]) <= 2);
    if (!row) { row = { coordinate: word[coordinate], words: [] }; rows.push(row); }
    row.words.push(word);
  }
  return rows.flatMap(row => {
    const words = row.words.sort((a, b) => a.x0 - b.x0), groups = [];
    const heights = words.map(word => word.bottom - word.top).sort((a, b) => a - b);
    const gap = Math.max(24, heights[Math.floor(heights.length / 2)] * 3);
    for (const word of words) {
      const previous = groups.at(-1);
      if (!previous || splitGaps && word.x0 - previous.at(-1).x1 > gap) groups.push([word]);
      else previous.push(word);
    }
    return groups.map(group => ({ words: group, text: group.map(word => word.text).join(' '),
      x0: Math.min(...group.map(word => word.x0)), x1: Math.max(...group.map(word => word.x1)),
      top: Math.min(...group.map(word => word.top)), bottom: Math.max(...group.map(word => word.bottom)) }));
  });
}

function hasSourceContinuationPrefix(text, rows) {
  if (!/^\p{Ll}/u.test(text)) return false;
  const expected = tokens(text);
  const matches = rows.filter(row => occurrence(tokens(row.text), expected) === 0);
  if (matches.length !== 1) return false;
  const current = matches[0], height = current.bottom - current.top;
  const previous = rows.filter(row => row !== current && row.bottom < current.bottom - height * .5
    && Math.abs(row.x0 - current.x0) <= height * 2
    && Math.min(row.x1, current.x1) - Math.max(row.x0, current.x0) >= Math.min(row.x1 - row.x0, current.x1 - current.x0) * .5)
    .sort((a, b) => b.bottom - a.bottom)[0];
  return Boolean(previous && current.bottom - previous.bottom <= Math.max(height, previous.bottom - previous.top) * 2
    && /\p{L}[-\u00ad\u2010]$/u.test(previous.text));
}

function referenceAnchorAmbiguities(pages, targetNumber) {
  const region = (row, page) => row.bottom <= page.height * .16 ? 'top' : row.top >= page.height * .84 ? 'bottom' : null;
  const samePlace = (a, ap, b, bp) => Math.abs(a.top / ap.height - b.top / bp.height) <= .01
    && Math.abs((a.x0 + a.x1) / (ap.width || 600) - (b.x0 + b.x1) / (bp.width || 600)) <= .06;
  const all = pages.filter(page => !page.status || page.status === 'ok').map(page => ({ page, rows: sourceWordRows(page) }));
  for (const entry of all) for (const row of entry.rows) {
    row.region = region(row, entry.page); row.variants = []; row.pageLabelProofs = [];
    if (!row.region) continue;
    const remaining = [...row.words];
    for (const edge of new Set([row.words[0], row.words.at(-1)])) {
      if (!/^\d+$/u.test(edge.text)) continue;
      const offset = Number(edge.text) - entry.page.pageNumber;
      const witnesses = all.filter(other => other.rows.some(line => region(line, other.page) === row.region
        && line.words.some(word => /^\d+$/u.test(word.text) && Number(word.text) - other.page.pageNumber === offset
          && samePlace(edge, entry.page, word, other.page)))).map(other => other.page.pageNumber);
      if (witnesses.length < 3) continue;
      row.pageLabelProofs.push({ text: edge.text, offset, witnesses }); remaining.splice(remaining.indexOf(edge), 1);
    }
    const variant = words => ({ text: words.map(word => word.text).join(' '), top: row.top, bottom: row.bottom,
      x0: words[0].x0, x1: words.at(-1).x1 });
    row.variants.push(variant(row.words));
    if (remaining.length && remaining.length !== row.words.length) row.variants.push(variant(remaining));
  }
  const target = all.find(entry => entry.page.pageNumber === targetNumber), exclusions = [], proofs = [];
  for (const row of target?.rows || []) for (const candidate of row.variants) {
    if (!/\p{L}/u.test(candidate.text)) continue;
    const witnesses = all.filter(other => other.rows.some(line => line.region === row.region
      && line.variants.some(value => furnitureKey(value.text) === furnitureKey(candidate.text)
        && samePlace(candidate, target.page, value, other.page)))).map(other => other.page.pageNumber);
    if (witnesses.length < 2) continue;
    exclusions.push(canonicalFurnitureText(row.text, target.page), canonicalFurnitureText(candidate.text, target.page));
    proofs.push({ text: canonicalFurnitureText(candidate.text, target.page), rawText: candidate.text,
      completePhysicalRow: row.text, region: row.region, bbox: [candidate.x0, candidate.top, candidate.x1, candidate.bottom],
      pages: witnesses, pageLabelProofs: row.pageLabelProofs });
  }
  return { exclusions, proofs };
}

async function pin(filename) {
  const digest = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(filename)) { bytes += chunk.length; digest.update(chunk); }
  return { path: filename, bytes, sha256: digest.digest('hex') };
}
async function json(filename, value) { await writeFile(filename, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }

export function rankLibraryPages(sha256, count, seed, maximum = 12) {
  const exposed = new Set([1, ...[.15, .5, .85].map(f => Math.max(1, Math.round(count * f))), count]);
  return Array.from({ length: Math.max(0, count - 6) }, (_, i) => i + 4).filter(p => !exposed.has(p))
    .map(page => ({ page, rank: hash(`${seed}\0${sha256}\0${page}`) }))
    .sort((a, b) => a.rank.localeCompare(b.rank)).slice(0, maximum).map(row => row.page);
}

export function libraryReferencePageRequests(ranked, pageCount) {
  assert(Array.isArray(ranked) && ranked.length <= 12 && new Set(ranked).size === ranked.length
    && Number.isSafeInteger(pageCount) && pageCount > 0
    && ranked.every(page => Number.isSafeInteger(page) && page >= 4 && page <= pageCount - 3), 'Invalid independent page-request bounds');
  const preceding = [...new Set(ranked.flatMap(page => [page - 3, page - 2, page - 1, page]))].sort((a, b) => a - b);
  const existing = new Set(preceding);
  const forward = [...new Set(ranked.flatMap(page => [page + 1, page + 2, page + 3]))]
    .filter(page => page <= pageCount && !existing.has(page)).sort((a, b) => a - b);
  assert(preceding.length <= 48 && forward.length <= 36, 'Independent reference request limit exceeded');
  return { preceding, forward };
}

function occurrence(haystack, needle, start = 0) {
  for (let i = start; i <= haystack.length - needle.length; i++) {
    if (needle.every((value, j) => haystack[i + j] === value)) return i;
  }
  return -1;
}

export function referenceCheckpoints(layoutText, rawPdfJsText, protocol, forbidden = [], sourcePage = null) {
  if (String(layoutText).replace(/\s/gu, '').length < protocol.minimumReferenceCharacters) return null;
  const reference = tokens(layoutText), cross = tokens(rawPdfJsText);
  const omitted = new Set(forbidden.map(furnitureKey).filter(Boolean));
  const lines = String(layoutText).split(/\r?\n/u).map(value => value.trim()).filter(Boolean);
  const sourceRows = sourcePage ? sourceWordRows(sourcePage, { byBottom: true, splitGaps: true }) : [];
  const possible = []; let referenceCursor = 0;
  for (const [lineIndex, line] of lines.entries()) {
    if (omitted.has(furnitureKey(line))) continue;
    let text = line;
    // A checkpoint boundary must not assert a fragment of a source word. Keep
    // the remaining verbatim span; do not guess joined versus compound spelling.
    if (lineIndex && /\p{L}[-\u00ad\u2010]$/u.test(lines[lineIndex - 1]) && /^\p{Ll}/u.test(text)
      || hasSourceContinuationPrefix(text, sourceRows)) text = text.replace(/^\S+\s*/u, '');
    if (/\p{L}[-\u00ad\u2010]$/u.test(text)) text = text.replace(/(?:^|\s)\S+$/u, '').trim();
    if (text.length > protocol.maximumAnchorCharacters) {
      const boundary = text.lastIndexOf(' ', protocol.maximumAnchorCharacters);
      if (boundary < protocol.minimumAnchorCharacters) continue;
      text = text.slice(0, boundary);
    }
    if (text.length < protocol.minimumAnchorCharacters || (text.match(/\p{L}/gu) || []).length < protocol.minimumAnchorLetterCharacters) continue;
    const expected = tokens(text);
    if (!expected.length) continue;
    const at = occurrence(reference, expected, referenceCursor);
    if (at < 0) continue;
    referenceCursor = at + expected.length;
    if (occurrence(reference, expected, at + 1) >= 0) continue;
    const crossAt = occurrence(cross, expected);
    if (crossAt < 0 || occurrence(cross, expected, crossAt + 1) >= 0) continue;
    possible.push({ text, at, end: at + expected.length, crossAt, crossEnd: crossAt + expected.length });
  }
  // A single fixed maximum-length increasing sequence removes ambiguous oracle ordering.
  const bestRows = [];
  const best = possible.map((row, index) => {
    let prefix = [];
    for (let i = 0; i < index; i++) {
      if (possible[i].crossEnd <= row.crossAt && possible[i].end <= row.at && bestRows[i].length > prefix.length) prefix = bestRows[i];
    }
    const result = [...prefix, index]; bestRows.push(result); return result;
  });
  const chain = best.reduce((a, b) => a.length >= b.length ? a : b, []);
  if (chain.length < protocol.checkpoints) return null;
  return Array.from({ length: protocol.checkpoints }, (_, index) => possible[chain[Math.round(index * (chain.length - 1) / (protocol.checkpoints - 1))]].text);
}

export function referenceFurniture(pages, targetNumber) {
  const target = pages.find(page => page.pageNumber === targetNumber);
  if (!target) return { forbidden: [], support: [], status: 'no-unambiguous-furniture' };
  const lines = page => {
    const rows = [];
    for (const word of [...(page.rawWords || [])].sort((a, b) => a.top - b.top || a.x0 - b.x0)) {
      let row = rows.find(value => Math.abs(value.top - word.top) <= 2);
      if (!row) { row = { top: word.top, bottom: word.bottom, x0: word.x0, x1: word.x1, words: [] }; rows.push(row); }
      row.words.push(word); row.bottom = Math.max(row.bottom, word.bottom); row.x0 = Math.min(row.x0, word.x0); row.x1 = Math.max(row.x1, word.x1);
    }
    return rows.flatMap(row => {
      const groups = [];
      for (const word of row.words.sort((a, b) => a.x0 - b.x0)) {
        const group = groups.at(-1);
        if (group && word.x0 - group.x1 <= Math.max(24, (row.bottom - row.top) * 3)) {
          group.words.push(word); group.x1 = Math.max(group.x1, word.x1);
        } else groups.push({ ...row, x0: word.x0, x1: word.x1, words: [word] });
      }
      return groups.map(group => ({ ...group, text: group.words.map(word => word.text).join(' ') }));
    });
  };
  const all = pages.filter(page => !page.status || page.status === 'ok').map(page => ({ page, lines: lines(page) }));
  const margin = (line, page) => line.bottom <= page.height * .16 ? 'top' : line.top >= page.height * .84 ? 'bottom' : null;
  const isolated = (line, rows, region) => {
    const gaps = rows.filter(row => region === 'top' ? row.top > line.bottom + 1 : row.bottom < line.top - 1)
      .map(row => region === 'top' ? row.top - line.bottom : line.top - row.bottom);
    return gaps.length && Math.min(...gaps) >= (line.bottom - line.top) * 1.8;
  };
  const samePlace = (left, lp, right, rp) => Math.abs(left.top / lp.height - right.top / rp.height) <= .01
    && Math.abs((left.x0 + left.x1) / (lp.width || 600) - (right.x0 + right.x1) / (rp.width || 600)) <= .06;
  const body = all.flatMap(({ page, lines: rows }) => rows.filter(line => !margin(line, page)
    || !isolated(line, rows, margin(line, page))).map(line => canonicalFurnitureText(line.text, page)));
  const support = [];
  const targetLines = lines(target);
  const candidates = [];
  for (const line of targetLines) {
    const region = margin(line, target);
    if (!region || !isolated(line, targetLines, region)) continue;
    // Prove edge page numbers separately, so changing numbers cannot hide a
    // recurrent chapter header on the same physical line.
    const remaining = [...line.words];
    for (const edge of [line.words[0], line.words.at(-1)]) {
      if (!/^\d+$/u.test(edge.text)) continue;
      const offset = Number(edge.text) - targetNumber;
      const witnesses = all.filter(({ page, lines: rows }) => rows.some(row => margin(row, page) === region
        && row.words.some(word => /^\d+$/u.test(word.text) && Number(word.text) - page.pageNumber === offset
          && samePlace(word, page, edge, target)))).map(row => row.page.pageNumber);
      if (witnesses.length < 3) continue;
      candidates.push({ ...line, ...edge, text: edge.text });
      const index = remaining.indexOf(edge); if (index >= 0) remaining.splice(index, 1);
    }
    if (remaining.length) candidates.push({ ...line, words: remaining, x0: remaining[0].x0,
      x1: remaining.at(-1).x1, text: remaining.map(word => word.text).join(' ') });
  }
  for (const line of candidates) {
    const region = margin(line, target), value = furnitureKey(line.text);
    if (!region || !value) continue;
    const numeric = /^\d+$/u.test(line.text.trim());
    const offset = Number(line.text) - target.pageNumber;
    const witnesses = all.filter(({ page, lines: rows }) => rows.some(row => {
      if (margin(row, page) !== region || !isolated(row, rows, region)) return false;
      if (numeric) return row.words.some(word => /^\d+$/u.test(word.text) && Number(word.text) - page.pageNumber === offset
        && samePlace(word, page, line, target));
      const withoutEdges = [...row.words];
      if (withoutEdges.length > 1 && /^\d+$/u.test(withoutEdges[0].text)) withoutEdges.shift();
      if (withoutEdges.length > 1 && /^\d+$/u.test(withoutEdges.at(-1).text)) withoutEdges.pop();
      const text = withoutEdges.map(word => word.text).join(' ');
      const place = { ...row, x0: withoutEdges[0]?.x0 ?? row.x0, x1: withoutEdges.at(-1)?.x1 ?? row.x1 };
      return (furnitureKey(row.text) === value && samePlace(row, page, line, target))
        || furnitureKey(text) === value && samePlace(place, page, line, target);
    })).map(row => row.page.pageNumber);
    if (witnesses.length < 3) continue;
    const text = canonicalFurnitureText(line.text, target);
    const bodyCollision = body.some(other => numeric
      ? /^\d+$/u.test(other) && furnitureKey(other) === value
      : furnitureKey(other) === value || occurrence(tokens(other), tokens(text)) >= 0);
    support.push({ text, rawText: line.text, region, bbox: [line.x0, line.top, line.x1, line.bottom], pages: witnesses,
      bodyCollision, kind: numeric ? 'marginal-page-number' : 'repeated-running-furniture' });
  }
  const forbidden = [...new Set(support.filter(row => !row.bodyCollision).map(row => row.text))];
  const ambiguous = referenceAnchorAmbiguities(pages, targetNumber);
  return { forbidden, support, anchorExclusions: [...new Set([...support.map(row => row.text), ...ambiguous.exclusions])],
    anchorAmbiguities: ambiguous.proofs,
    status: forbidden.length ? 'reference-derived' : 'no-unambiguous-furniture' };
}

async function inventory(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile() && /\.pdf$/iu.test(entry.name)) result.push({ ...await pin(filename), relativePath: path.relative(root, filename) });
    }
  }
  await visit(root); return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function main() {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) { assert(['--source-root', '--output', '--python', '--pdftoppm', '--private-manifest'].includes(args[i]) && args[i + 1]); options[args[i]] = args[i + 1]; }
  for (const name of ['--source-root', '--output', '--python', '--pdftoppm']) assert(options[name], `Missing ${name}`);
  const sourceRoot = await realpath(options['--source-root']), output = path.resolve(options['--output']);
  const relativeOutput = path.relative(sourceRoot, output);
  assert(path.isAbsolute(relativeOutput) || relativeOutput.startsWith('..' + path.sep), 'Keep generated references outside the supplied books');
  await mkdir(output); await mkdir(path.join(output, 'references')); await mkdir(path.join(output, 'previews'));
  const protocolPath = path.join(ROOT, 'config/pdf-library-reference-protocol.json'), protocol = JSON.parse(await readFile(protocolPath, 'utf8'));
  const privateManifestPath = path.resolve(options['--private-manifest'] || path.join(ROOT, '.cache/pdf-library-v1-20261024-reference-05/manifest.private.json'));
  const privateRouting = JSON.parse(await readFile(privateManifestPath, 'utf8')).routingControls;
  assert(Array.isArray(privateRouting) && privateRouting.length === protocol.routingControls.length, 'Missing private routing identities');
  assert.deepEqual(privateRouting.map(({ categories, expectedCode }) => ({ categories, expectedCode })),
    protocol.routingControls.map(({ categories, expectedCode }) => ({ categories, expectedCode })), 'Private routing contract changed');
  const helper = path.join(ROOT, 'scripts/lib/pdf-library-reference.py');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const referenceAssets = [];
  async function collectAssets(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await collectAssets(filename); else if (entry.isFile()) referenceAssets.push(filename);
    }
  }
  for (const directory of ['cmaps', 'standard_fonts']) await collectAssets(path.join(ROOT, 'node_modules/pdfjs-dist', directory));
  referenceAssets.sort();
  const generatorPins = await Promise.all([fileURLToPath(import.meta.url), helper, protocolPath, privateManifestPath,
    path.join(ROOT, 'scripts/lib/pdf-library-public-manifest.mjs'),
    path.join(ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs'), path.join(ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'),
    path.resolve(options['--python']), path.resolve(options['--pdftoppm']), ...referenceAssets].map(pin));
  const files = await inventory(sourceRoot), inventoryPath = path.join(output, 'source-inventory.json');
  await json(inventoryPath, { schemaVersion: 1, sourceRoot, files }); const inventoryPin = await pin(inventoryPath);
  const unique = [...new Map(files.filter(file => file.bytes <= protocol.maximumSourceBytes).map(file => [file.sha256, file])).values()]
    .map(file => ({ ...file, rank: hash(`${protocol.seed}\0${file.sha256}`) })).sort((a, b) => a.rank.localeCompare(b.rank));
  await json(path.join(output, 'preregistration.json'), { createdAt: new Date().toISOString(), protocol, generatorPins, inventory: inventoryPin,
    rankedDocuments: unique.map(({ sha256, rank }) => ({ sha256, rank })), noProductOutputsUsed: true });
  const records = [], outcomes = [], pageDigests = new Set();
  for (const file of unique) {
    if (records.length === protocol.documents * protocol.pagesPerDocument) break;
    const documentId = file.sha256.slice(0, 16), prefix = path.join(output, 'references', documentId);
    let task;
    try {
      const bytes = new Uint8Array(await readFile(file.path)); assert.equal(hash(bytes), file.sha256);
      task = pdfjs.getDocument({ data: bytes, disableFontFace: true, useSystemFonts: false, enableScripting: false,
        standardFontDataUrl: pathToFileURL(path.join(ROOT, 'node_modules/pdfjs-dist/standard_fonts/')).href,
        cMapUrl: pathToFileURL(path.join(ROOT, 'node_modules/pdfjs-dist/cmaps/')).href, cMapPacked: true, verbosity: 0 });
      const document = await task.promise;
      const ranked = rankLibraryPages(file.sha256, document.numPages, protocol.seed, protocol.candidatePagesPerDocument);
      if (ranked.length < protocol.pagesPerDocument) throw new Error('Not enough unexposed page candidates');
      const { preceding: requested, forward: forwardRequested } = libraryReferencePageRequests(ranked, document.numPages);
      const pythonPath = prefix + '-pdfminer.json';
      let pythonExit = 0;
      try { await run(options['--python'], [helper, '--input', file.path, '--pages', requested.join(','), '--output', pythonPath], { windowsHide: true, maxBuffer: 1024 * 1024 }); }
      catch (error) { pythonExit = error.code; }
      const reference = JSON.parse(await readFile(pythonPath, 'utf8'));
      assert.equal(reference.input.sha256Before, file.sha256); assert.equal(reference.input.sha256After, file.sha256);
      assert.equal(reference.document.pageCount, document.numPages, 'Independent parsers disagree on page identity');
      assert(reference.input.unchanged);
      assert.deepEqual(reference.pages.map(page => page.pageNumber), requested, 'Primary reference omitted a requested page');
      // Forward witnesses apply to every hash-ranked candidate, before eligibility
      // or positive selection. Each original helper invocation retains its48cap.
      const forwardPath = prefix + '-pdfminer-forward.json';
      assert(forwardRequested.length > 0, 'Missing independent forward context');
      let forwardPythonExit = 0;
      try { await run(options['--python'], [helper, '--input', file.path, '--pages', forwardRequested.join(','), '--output', forwardPath], { windowsHide: true, maxBuffer: 1024 * 1024 }); }
      catch (error) { forwardPythonExit = error.code; }
      const forwardReference = JSON.parse(await readFile(forwardPath, 'utf8'));
      assert.equal(forwardReference.input.sha256Before, file.sha256); assert.equal(forwardReference.input.sha256After, file.sha256);
      assert(forwardReference.input.unchanged);
      assert.equal(forwardReference.document.pageCount, document.numPages, 'Forward reference page identity differs');
      assert.deepEqual(forwardReference.pages.map(page => page.pageNumber), forwardRequested, 'Forward reference omitted a requested page');
      for (const field of ['versions', 'moduleHashes', 'packageDigests', 'helper']) {
        assert.deepEqual(forwardReference.tools[field], reference.tools[field], `Independent reference ${field} changed between bounded captures`);
      }
      const furniturePages = [...reference.pages, ...forwardReference.pages].sort((a, b) => a.pageNumber - b.pageNumber);
      const picked = [], rejected = [];
      for (const pageNumber of ranked) {
        if (picked.length === protocol.pagesPerDocument) break;
        const context = reference.pages.filter(page => page.pageNumber >= pageNumber - 3 && page.pageNumber <= pageNumber);
        const pageReference = context.find(page => page.pageNumber === pageNumber);
        if (!pageReference || context.length !== 4 || context.some(page => page.status !== 'ok')) { rejected.push({ pageNumber, reason: 'independent-reference-or-resource-error' }); continue; }
        if (context.some(page => page.undefinedGlyphs?.length)) { rejected.push({ pageNumber, reason: 'independent-native-unicode-reference-unresolved' }); continue; }
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const raw = { pageNumber, pageView: page.view, items: content.items, styles: content.styles };
        const rawPath = `${prefix}-p${pageNumber}-pdfjs.json`; await json(rawPath, raw); page.cleanup();
        const furniture = referenceFurniture(furniturePages, pageNumber);
        const checkpoints = referenceCheckpoints(pageReference.layoutText, content.items.map(item => item.str || '').join(' '), protocol,
          [...furniture.forbidden, ...(furniture.anchorExclusions || [])], pageReference);
        const referenceDigest = hash(key(pageReference.layoutText));
        if (!checkpoints || pageDigests.has(referenceDigest) || picked.some(row => row.referenceDigest === referenceDigest)) { rejected.push({ pageNumber, reason: checkpoints ? 'duplicate-independent-page' : 'insufficient-unambiguous-oracle-checkpoints' }); continue; }
        picked.push({ pageNumber, checkpoints, furniture, rawPath, referenceDigest });
      }
      outcomes.push({ sha256: file.sha256, pageCount: document.numPages, rankedPages: ranked, pythonExit, forwardPythonExit,
        primaryPages: requested, forwardPages: forwardRequested, selectedPages: picked.map(row => row.pageNumber), rejected });
      if (picked.length !== protocol.pagesPerDocument) continue;
      const staged = [];
      for (const selected of picked.sort((a, b) => a.pageNumber - b.pageNumber)) {
        const id = `library-${documentId}-p${selected.pageNumber}`;
        const pngPrefix = path.join(output, 'previews', id);
        const render = await run(options['--pdftoppm'], ['-f', String(selected.pageNumber), '-l', String(selected.pageNumber), '-cropbox', '-scale-to', '1000', '-png', '-singlefile', file.path, pngPrefix], { windowsHide: true, maxBuffer: 1024 * 1024 });
        if (/Non conformant codestream|Invalid (?:JPEG2000|JPX)|JPXDecode (?:error|failed)/iu.test(render.stderr)) {
          await json(prefix + `-p${selected.pageNumber}-unresolved-render.json`, { pageNumber: selected.pageNumber, stderr: render.stderr,
            scope: 'Independent malformed/undecodable image reference; not a product evaluation.' });
          throw new Error('Independent reference renderer reports a nonconforming image codestream');
        }
        const evidencePath = prefix + `-p${selected.pageNumber}-selection.json`;
        await json(evidencePath, { id, selectedReferenceDigest: selected.referenceDigest, furniture: selected.furniture,
          rawReferenceScope: 'PDFMiner layout/words and standalone PDF.js raw items; no product narration or page-model inputs.', popplerStderr: render.stderr });
        const identity = { id, source: `private-library:${file.sha256}`, pageNumber: selected.pageNumber,
          narrationStartPage: selected.pageNumber - 3, sha256: file.sha256, categories: ['library'] };
        staged.push({ ...identity, privateFilePath: file.path, orderedCheckpoints: selected.checkpoints,
          forbiddenNarration: selected.furniture.forbidden, forbiddenNarrationStatus: selected.furniture.status,
          referencePins: await Promise.all([pythonPath, forwardPath, selected.rawPath, evidencePath, pngPrefix + '.png'].map(pin)) });
      }
      assert.equal((await pin(file.path)).sha256, file.sha256);
      records.push(...staged);
      for (const selected of picked) pageDigests.add(selected.referenceDigest);
      console.log(JSON.stringify({ selected: records.length, documents: records.length / protocol.pagesPerDocument, attempts: outcomes.length }));
    } catch (error) { outcomes.push({ sha256: file.sha256, error: error.message }); }
    finally { await task?.destroy(); await json(path.join(output, `selection-progress-${outcomes.length}.json`), { records: records.length, outcomes }); }
  }
  assert.equal(records.length, 90, 'Independent eligibility did not yield the preregistered 90 pages');
  const routingControls = [];
  await mkdir(path.join(output, 'routing-controls'));
  for (const identity of privateRouting) {
    const file = files.find(candidate => candidate.sha256 === identity.sha256);
    assert(file, 'Frozen native-routing source is missing from the supplied library');
    const prefix = path.join(output, 'routing-controls', identity.id), pythonPath = prefix + '-pdfminer.json';
    const requested = Array.from({ length: 4 }, (_, index) => identity.pageNumber - index).sort((a, b) => a - b);
    await run(options['--python'], [helper, '--input', file.path, '--pages', requested.join(','), '--output', pythonPath], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const reference = JSON.parse(await readFile(pythonPath, 'utf8'));
    assert.equal(reference.input.sha256Before, file.sha256); assert.equal(reference.input.sha256After, file.sha256);
    const target = reference.pages.find(page => page.pageNumber === identity.pageNumber);
    assert(target?.status === 'ok', 'Routing reference page could not be independently inspected');
    const render = await run(options['--pdftoppm'], ['-f', String(identity.pageNumber), '-l', String(identity.pageNumber), '-cropbox', '-scale-to', '1000', '-png', '-singlefile', file.path, prefix], { windowsHide: true, maxBuffer: 1024 * 1024 });
    if (identity.expectedCode === 'scanned_pdf_unsupported') {
      assert(target.undefinedGlyphs?.length && target.fontResources?.some(font => font.subtype === 'Type3' && !font.hasToUnicode),
        'The OCR-route reference must prove undefined single Type3 glyphs without a Unicode map');
    } else {
      assert.equal(identity.expectedCode, 'pdf_corrupt');
      assert(/Non conformant codestream.*TPsot==TNsot/iu.test(render.stderr), 'The corrupt-route reference must independently prove the invalid tile-part sequence');
    }
    const evidencePath = prefix + '-source-proof.json';
    await json(evidencePath, { identity, undefinedSingleGlyphs: target.undefinedGlyphs, fontResources: target.fontResources,
      popplerStderr: render.stderr, scope: 'Independent native-text reference limitation or malformed image proof. No product success or OCR recognition claim.' });
    routingControls.push({ ...identity, privateFilePath: file.path,
      referencePins: await Promise.all([pythonPath, evidencePath, prefix + '.png'].map(pin)) });
    assert.equal((await pin(file.path)).sha256, file.sha256);
  }
  assert.deepEqual(await Promise.all(generatorPins.map(row => pin(row.path))), generatorPins, 'Reference generator/tool inputs changed');
  const goldPath = path.join(output, 'gold.json');
  await json(goldPath, { schemaVersion: 1, benchmarkId: protocol.benchmarkId, sourceInventorySha256: inventoryPin.sha256, sourceRoot,
    referenceMethod: { protocol: await pin(protocolPath), generatorPins, pdfjsVersion: pdfjs.version, provenance: 'New independent reference baseline authorized by the user; not recovered historical gold.', selection: 'five-index page holdout in a consumed library; no unseen-document claim', positiveScope: 'Independently resolvable native text. Unresolved glyphs and known malformed image sources retain separate explicit native-refusal controls.' }, records, routingControls });
  const gold = await pin(goldPath);
  const privateManifest = { schemaVersion: 1, benchmarkId: protocol.benchmarkId, sourceInventorySha256: inventoryPin.sha256,
    gold: { bytes: gold.bytes, sha256: gold.sha256 }, records: records.map(({ id, source, pageNumber, narrationStartPage, sha256, categories }) => ({ id, source, pageNumber, narrationStartPage, sha256, categories })),
    routingControls: routingControls.map(({ privateFilePath: _private, referencePins: _pins, ...identity }) => identity) };
  await json(path.join(output, 'manifest.private.json'), privateManifest);
  await json(path.join(output, 'manifest.public.json'), publicPdfLibraryManifest(await readFile(path.join(output, 'manifest.private.json'))));
  await json(path.join(output, 'completion.json'), { status: 'independent-reference-frozen-before-product-evaluation', gold,
    publicManifest: await pin(path.join(output, 'manifest.public.json')), records: records.length, documents: 30, generatorPins,
    outcomeCount: outcomes.length, furniturePages: records.filter(row => row.forbiddenNarration.length).length, productOutputsUsed: false, humanRatingsGenerated: false });
  console.log(JSON.stringify({ output, gold: { bytes: gold.bytes, sha256: gold.sha256 }, records: 90 }));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
