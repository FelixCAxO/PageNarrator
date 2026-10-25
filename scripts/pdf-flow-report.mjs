#!/usr/bin/env node
// Measures narration flow on real PDFs through the production streaming path.
//
//   node scripts/pdf-flow-report.mjs <folder-or-pdf>... [--src <dir>] [--window 6]
//     [--fractions 0.15,0.4,0.65] [--json <file>] [--limit <n>]
//
// For page windows sampled through each PDF it counts:
//   breaks   mid-sentence stops: "word. lowercase" that is not an abbreviation
//   jumps    narrated lines that move back up the same column
//   leaks    running headers/footers narrated as their own sentence (the first
//            page of each window is skipped: it is spoken before read-ahead)
//   turns    pages whose narration starts mid-sentence (informational)
// --src points at another src/ tree (for example a pre-change snapshot) so two
// versions can be compared on identical inputs.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
const ABBREVIATION = /(?:\b(?:e\.g|i\.e|etc|al|vs|cf|fig|eq|no|vol|pp|dr|mr|mrs|ms|st|approx|resp|inc|ltd|co|ch|sec)|\b\p{Lu})$/iu;

function parseArgs(argv) {
  const options = { inputs: [], src: join(ROOT_DIR, 'src'), window: 6, fractions: [0.15, 0.4, 0.65], json: '', limit: Infinity };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--src') options.src = resolve(argv[++index]);
    else if (arg === '--window') options.window = Number(argv[++index]);
    else if (arg === '--fractions') options.fractions = argv[++index].split(',').map(Number);
    else if (arg === '--json') options.json = resolve(argv[++index]);
    else if (arg === '--limit') options.limit = Number(argv[++index]);
    else options.inputs.push(resolve(arg));
  }
  if (!options.inputs.length) throw new Error('Pass at least one PDF file or folder.');
  return options;
}

async function listPdfs(paths) {
  const files = [];
  for (const path of paths) {
    if ((await stat(path)).isDirectory()) {
      for (const entry of await readdir(path, { withFileTypes: true, recursive: true })) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) files.push(join(entry.parentPath ?? entry.path, entry.name));
      }
    } else {
      files.push(path);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function letters(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}]+/gu, '');
}

function signature(text) {
  return String(text || '').toLowerCase().replace(/\d+/gu, '').replace(/[^\p{L}]+/gu, ' ').trim();
}

function countBreaks(speech) {
  let count = 0;
  for (const match of speech.matchAll(/(\S+)\. (\p{Ll})/gu)) {
    if (!ABBREVIATION.test(match[1]) && !/\.\p{L}/u.test(match[1])) count += 1;
  }
  return count;
}

function countJumps(lines, speech) {
  const spoken = letters(speech);
  const narrated = lines.filter((line) => {
    const key = letters(line.text).slice(0, 24);
    return key.length >= 4 && spoken.includes(key);
  });
  let count = 0;
  for (let index = 1; index < narrated.length; index += 1) {
    const previous = narrated[index - 1];
    const line = narrated[index];
    const height = Math.max(4, ...previous.parts.map((part) => part.height || 0));
    const overlap = Math.max(0, Math.min(previous.right, line.right) - Math.max(previous.left, line.left));
    const narrower = Math.max(1, Math.min(previous.right - previous.left, line.right - line.left));
    if (line.y > previous.y + height * 1.5 && overlap / narrower > 0.2 && line.left < previous.right - 4) count += 1;
  }
  return count;
}

function edgeLines(record) {
  const [, rawBottom, , rawTop] = record.pageView;
  const top = Math.max(rawBottom, rawTop);
  const bottom = Math.min(rawBottom, rawTop);
  const band = (top - bottom) * 0.12;
  return record.lines
    .filter((line) => line.y >= top - band || line.y <= bottom + band)
    .map((line) => ({ signature: signature(line.text), text: line.text.replace(/\s+/gu, ' ').trim() }))
    .filter((line) => line.signature.length >= 3 && letters(line.text).length >= 4);
}

function narratedAsSentence(text, speech) {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|[.:!?;] )${escaped}[.:!?;]?(?: |$)`, 'iu').test(speech);
}

async function measurePdf(path, { pdfjs, extraction, window, fractions }) {
  const task = pdfjs.getDocument({ data: new Uint8Array(await readFile(path)), useSystemFonts: true, enableScripting: false, verbosity: 0 });
  const document = await task.promise;
  const totals = { pages: document.numPages, breaks: 0, jumps: 0, leaks: 0, turns: 0 };
  try {
    for (const start of [...new Set(fractions.map((fraction) => Math.max(1, Math.round(document.numPages * fraction))))]) {
      const end = Math.min(document.numPages, start + window - 1);
      const speechByPage = new Map();
      for await (const chunk of extraction.iteratePdfSpeechChunks(document, { pdfjs, startPage: start })) {
        if (chunk.pageNumber > end) break;
        speechByPage.set(chunk.pageNumber, `${speechByPage.get(chunk.pageNumber) || ''} ${chunk.speech}`.trim());
      }
      const pages = [];
      for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
        const record = await extraction.readPdfPageRecord(document, pageNumber, { pdfjs });
        const speech = speechByPage.get(pageNumber) || '';
        pages.push({ pageNumber, speech, edges: edgeLines(record) });
        totals.breaks += countBreaks(speech);
        totals.jumps += countJumps(record.lines, speech);
        if (pageNumber > start && /^\p{Ll}/u.test(speech)) totals.turns += 1;
      }
      for (const page of pages.slice(1)) {
        for (const edge of page.edges) {
          const repeated = pages.some((other) => other !== page && other.edges.some((candidate) => candidate.signature === edge.signature));
          if (repeated && narratedAsSentence(edge.text, page.speech)) totals.leaks += 1;
        }
      }
    }
  } finally {
    await task.destroy();
  }
  return totals;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(join(ROOT_DIR, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
  const extraction = await import(pathToFileURL(join(options.src, 'lib/pdf-extraction.js')).href);
  const files = (await listPdfs(options.inputs)).slice(0, options.limit);
  const results = [];
  for (const file of files) {
    try {
      results.push({ file: basename(file), ...await measurePdf(file, { pdfjs, extraction, ...options }) });
    } catch (error) {
      results.push({ file: basename(file), error: String(error?.code || error?.message || error) });
    }
    const result = results.at(-1);
    process.stdout.write(`${result.file.slice(0, 56).padEnd(56)} ${result.error
      ? `error: ${result.error}`
      : `pages=${result.pages} breaks=${result.breaks} jumps=${result.jumps} leaks=${result.leaks} turns=${result.turns}`}\n`);
  }
  const measured = results.filter((result) => !result.error);
  const total = (key) => measured.reduce((sum, result) => sum + result[key], 0);
  process.stdout.write(`TOTAL pdfs=${measured.length}/${results.length} breaks=${total('breaks')} jumps=${total('jumps')} leaks=${total('leaks')} turns=${total('turns')}\n`);
  if (options.json) await writeFile(options.json, `${JSON.stringify(results, null, 2)}\n`);
}

await main();
