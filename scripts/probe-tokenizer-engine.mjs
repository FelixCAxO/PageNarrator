// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { Qwen2Tokenizer } from '@huggingface/transformers';
import manifest from '../tests/fixtures/browser-speech-models.json' with { type: 'json' };

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const modelRoot = resolve(root, process.env.PN_BROWSER_MODEL_DIR || '.cache/engine-models', manifest.modelId);
const output = resolve(root, 'artifacts/engines/tokenizer-parity.json');
const tokenizerFiles = new Map();
for (const file of manifest.files.filter(file => file.path.startsWith('tokenizer'))) {
  const data = await readFile(resolve(modelRoot, file.path));
  if (data.byteLength !== file.bytes || createHash('sha256').update(data).digest('hex') !== file.sha256) throw new Error(`Pinned tokenizer data mismatch: ${file.path}`);
  tokenizerFiles.set(file.path, data);
}
const json = JSON.parse(tokenizerFiles.get('tokenizer.json').toString('utf8'));
const config = JSON.parse(tokenizerFiles.get('tokenizer_config.json').toString('utf8'));
const samples = [
  '', 'Hello, world!', "I'm reading PageNarrator. I'M ready; we're here.", '123456789 3.14159 -0.08',
  'Åäö: Vi läser svenska och behåller tecknen.', 'Les caractères français sont préservés.', 'Straße, Größen, Fußgänger.',
  'Español: ¿cómo estás? Português: ação.', 'Zażółć gęślą jaźń.', 'Καλημέρα κόσμε.', 'Привет, мир!',
  'שלום עולם, עם ניקוד: שָׁלוֹם.', 'العربية: مرحبًا بالعالم.', 'हिन्दी में नमस्ते दुनिया।', 'বাংলায় স্বাগতম।',
  '中文文本和标点：你好，世界！', '日本語の文章を読みます。', '한국어 문장을 읽습니다.', 'ภาษาไทยและตัวเลข ๑๒๓',
  'Tiếng Việt: Xin chào thế giới.', 'ქართული ენა და სომხური Հայերեն։', 'e\u0301 café 👩🏽‍💻 🏳️‍🌈 🤖',
  '\r\n  lines\twith\u00a0space\u2028and\u200bmarkers\u0000', "'ſ 'S 'RE 've 'm", ' '.repeat(70) + 'last', 'a'.repeat(65536),
  '<|lang_start|>arb<|lang_end|><|instruct_start|>None<|instruct_end|><|text_start|>مرحبًا<|text_end|>',
];
let state = 0x50a6e;
const glyphs = Array.from("abcDEF0123 '-\n\tÅöé́漢字العربيةשָहिन्दी한글ქართული👩🏽‍💻🤖");
const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
for (let sample = 0; sample < 200; sample++) samples.push(Array.from({ length: 1 + random() % 180 }, () => glyphs[random() % glyphs.length]).join(''));
for (const token of json.added_tokens) samples.push(token.content, `${token.content}hello${token.content}`);
// The Node oracle receives private copies; it cannot alter the browser candidate's input data.
const reference = new Qwen2Tokenizer(structuredClone(json), structuredClone(config));
const expectedTokens = samples.map(text => Array.from(reference.encode(text, { add_special_tokens: false })));
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
    if (pathname === '/') { response.writeHead(200, { ...headers, 'Content-Type': 'text/html' }); response.end('<!doctype html><title>PageNarrator tokenizer verification</title>'); return; }
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    const path = resolve(root, `.${pathname}`);
    const type = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' }[extname(path)];
    const allowed = path.startsWith(`${root}${sep}`);
    if (!allowed || !type) { response.writeHead(404); response.end(); return; }
    const data = await readFile(path);
    response.writeHead(200, { ...headers, 'Content-Type': type }); response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(ready => server.listen(0, '127.0.0.1', ready));
let browser;
try {
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async ({ samples, expectedTokens, json, config }) => {
    const { BytePairTokenizer } = await import('/src/engines/bytepair-tokenizer.js');
    const candidate = new BytePairTokenizer(json, config);
    let tokens = 0, candidateMs = 0;
    for (let i = 0; i < samples.length; i++) {
      const text = samples[i], startCandidate = performance.now();
      const actual = candidate.encode(text, { add_special_tokens: false }); candidateMs += performance.now() - startCandidate;
      const expected = expectedTokens[i];
      const different = actual.length !== expected.length || actual.some((id, j) => id !== expected[j]);
      if (different) throw new Error(`Tokenizer case ${i} differs: ${JSON.stringify({ text: text.slice(0, 300), actual: actual.slice(0, 50), expected: expected.slice(0, 50) })}`);
      const cached = candidate.encode(text, { add_special_tokens: false });
      if (cached.length !== actual.length || cached.some((id, j) => id !== actual[j])) throw new Error(`Tokenizer cache mismatch in case ${i}.`);
      tokens += actual.length;
    }
    return { cases: samples.length, tokens, cacheWords: candidate.cache.size, candidateMs,
      timingScope: 'Single Chromium candidate/cache pass; Node oracle is untimed. No cross-runtime performance or narration acceptance claim.' };
  }, { samples, expectedTokens, json, config });
  if (errors.length) throw new Error(errors.join('\n'));
  const report = { status: 'pass', browser: browser.version(), modelId: manifest.modelId, revision: manifest.revision,
    tokenizerSha256: manifest.files.find(file => file.path === 'tokenizer.json').sha256,
    tokenizerConfigSha256: manifest.files.find(file => file.path === 'tokenizer_config.json').sha256,
    reference: 'Node Transformers 3.8.1 Qwen2Tokenizer (isolated development oracle)', ...result };
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); await new Promise(done => server.close(done)); }
