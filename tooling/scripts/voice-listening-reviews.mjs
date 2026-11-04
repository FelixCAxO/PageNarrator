import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readQualityFreeze, qualityFingerprint, qualitySourceAssociation } from './lib/kokoro-quality-controls.mjs';
import { assessVoiceListening, VOICE_QUALITY_PROTOCOL, VOICE_REVIEW_CORPUS, voiceCaseId } from './lib/voice-quality-assessment.mjs';
import { waveBytes } from './lib/kokoro-speech-acceptance.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const protocolPath = new URL('../config/voice-quality-protocol.json', import.meta.url);
const escape = value => String(value).replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
async function clipBytes(directory, descriptor) {
  if (!descriptor || basename(descriptor.file) !== descriptor.file || /[\\:\0]/u.test(descriptor.file) || descriptor.file === '.' || descriptor.file === '..') throw new Error('Invalid voice clip path.');
  const root = await realpath(directory), file = await realpath(resolve(directory, descriptor.file));
  if (!file.startsWith(`${root}${sep}`)) throw new Error('Voice clip escapes its report directory.');
  const bytes = await readFile(file);
  if (bytes.length !== descriptor.bytes || hash(bytes) !== descriptor.sha256) throw new Error('Voice clip bytes changed.');
  return bytes;
}

export function createVoiceReviewHtml(packet, packetSha256) {
  const dimensions = VOICE_QUALITY_PROTOCOL.dimensions;
  const rows = packet.samples.map((sample, i) => `<section data-sample="${escape(sample.id)}"><h2>Pair ${i + 1}</h2><p>${escape(sample.text)}</p>${sample.intendedSpeech ? `<details><summary>Allowed spoken wording</summary>${sample.intendedSpeech.map(text => `<p>${escape(text)}</p>`).join('')}</details>` : ''}${['A', 'B'].map(label => `<fieldset><legend>${label}</legend><audio controls preload="none" src="media/${escape(sample[label].file)}"></audio>${dimensions.map(d => `<label>${escape(d)} <select data-label="${label}" data-dimension="${escape(d)}"><option value="">Unrated</option>${[1, 2, 3, 4, 5].map(n => `<option>${n}</option>`).join('')}</select></label>`).join('')}<label><input type="checkbox" data-content="${label}"> All intended words and numbers are present, with correct pronunciation, no repeats, and valid audio.</label></fieldset>`).join('')}</section>`).join('\n');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'">
<title>Blind voice review</title><style>body{font:17px/1.5 system-ui;max-width:900px;margin:40px auto;padding:0 20px}section{border-top:1px solid #bbb;padding:24px 0}label{display:block;margin:12px 0}select,input,button{font:inherit}audio{width:100%}fieldset{margin:16px 0}</style>
<h1>Blind voice review</h1><p>Listen independently without consulting other reviewers. Rate intelligibility, voice identity, pronunciation and prosody from 1 (very poor) to 5 (excellent). Compare the same voice across passages. Check content against the intended text, including numbers and abbreviations. Leave unassigned pairs unrated. Missing content checks report unresolved errors. Audio and responses stay on your device.</p>
${rows}<form id="review"><label>Your stable reviewer ID or pseudonym <input id="reviewer" required autocomplete="off"></label><label><input id="human" type="checkbox" required> I am a human and reviewed these clips independently without knowing which version was the candidate.</label><button>Export original responses</button><p id="status" role="status"></p></form>
<script>const packetSha256=${JSON.stringify(packetSha256)};
document.getElementById('review').addEventListener('submit',event=>{event.preventDefault();const samples=[];
for(const row of document.querySelectorAll('[data-sample]')){const inputs=[...row.querySelectorAll('select')];if(!inputs.some(x=>x.value))continue;if(inputs.some(x=>!x.value)){document.getElementById('status').textContent='Complete all eight scores for each rated pair.';return;}const sample={id:row.dataset.sample};for(const label of ['A','B'])sample[label]={scores:Object.fromEntries(inputs.filter(x=>x.dataset.label===label).map(x=>[x.dataset.dimension,Number(x.value)])),contentCorrect:row.querySelector('[data-content="'+label+'"]').checked};samples.push(sample);}
if(!samples.length)return;const response={schemaVersion:1,kind:'human',independentBlindedHumanReview:document.getElementById('human').checked,reviewerId:document.getElementById('reviewer').value.trim(),reviewedAt:new Date().toISOString(),packetSha256,samples};const url=URL.createObjectURL(new Blob([JSON.stringify(response,null,2)+'\\n'],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='voice-review.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);document.getElementById('status').textContent='Keep the downloaded original response unchanged.';});</script></html>`;
}

export async function prepareVoiceReviews(root, freezePath, reports, directory) {
  const freeze = await readQualityFreeze(root, freezePath), freezeSha256 = hash(await readFile(freezePath));
  const packet = { schemaVersion: 1, method: VOICE_QUALITY_PROTOCOL.method, partition: 'test', evaluationScope: 'frozen-corpus-regression-study',
    corpusSha256: freeze.corpusSha256, freezeSha256, protocolSha256: hash(await readFile(protocolPath)), samples: [] };
  const key = { freezePath: resolve(freezePath), candidateLabels: {}, reports: [] }, backends = new Set(), ids = new Set();
  await mkdir(directory); await mkdir(resolve(directory, 'media'));
  for (const path of reports) {
    const bytes = await readFile(path), report = JSON.parse(bytes), backend = report.device;
    if (!VOICE_QUALITY_PROTOCOL.backends.includes(backend) || backends.has(backend) || report.partition !== 'test'
      || report.functionalStatus !== 'pass' || report.manifestSha256 !== freezeSha256) throw new Error('Need one complete current test report per backend.');
    backends.add(backend); key.reports.push({ path: resolve(path), sha256: hash(bytes) });
    for (const item of report.cases) {
      const entry = VOICE_REVIEW_CORPUS.test.find(x => x.id === item.entry?.id), voice = item.entry?.voice;
      const id = voiceCaseId(backend, voice, entry?.id);
      if (!entry || !VOICE_REVIEW_CORPUS.voices.includes(voice) || item.entry.text !== entry.text || item.entry.speed !== 1 || ids.has(id)) throw new Error('Unknown, changed or duplicate quality case.');
      ids.add(id); qualitySourceAssociation(entry.text, item.candidate.chunks);
      const dtype = backend === 'wasm' ? 'q8' : 'fp32', graph = freeze.data.files.find(x => x.path === (backend === 'wasm' ? 'onnx/model_quantized.onnx' : 'onnx/model.onnx'));
      const fingerprint = qualityFingerprint({ corpus: freeze.corpusSha256, entry: item.entry, dtype, lane: item.candidate.backend, data: freeze.data,
        sourcePins: freeze.sourcePins, packagedBuild: freeze.packagedBuild, policy: 'Actual app registry/worker, raw fixture text into stream, phase correction enabled.' });
      const legacyFingerprint = qualityFingerprint({ corpus: freeze.corpusSha256, entry: item.entry, dtype, rawGraph: graph, data: freeze.data,
        legacyPins: freeze.legacyPins, inputPolicy: 'Raw fixture text pushed once into public TextSplitterStream and closed; unmodified KokoroTTS.stream normalization/tokenization/eSpeak.' });
      if (item.entry.mode !== 'stream' || item.candidate.fingerprint !== fingerprint || item.candidate.dtype !== dtype
        || item.candidate.modelInfo?.originalSha256 !== graph.sha256 || item.candidate.modelInfo?.version !== 'kokoro-exact-zero-phase-v2'
        || item.legacy.fingerprint !== legacyFingerprint || item.legacy.dtype !== dtype || item.legacy.graphSha256 !== graph.sha256
        || (backend === 'wasm' ? item.candidate.backend !== 'wasm' : !item.candidate.backend || item.candidate.backend === 'wasm')) throw new Error('Quality clip source, model or actual backend differs.');
      const sample = { id, backend, voice, category: entry.category, text: entry.text, intendedSpeech: freeze.expectedSpoken[entry.id] }, label = randomInt(2) ? 'A' : 'B';
      key.candidateLabels[id] = label;
      for (const [variant, record] of [['candidate', item.candidate], ['reference', item.legacy]]) {
        if (record.sampleRate !== 24000 || !Number.isFinite(record.rms) || record.rms < .001 || !Number.isSafeInteger(record.samples) || record.samples < 1) throw new Error('Invalid or silent quality audio.');
        const raw = await clipBytes(dirname(path), record.raw);
        if (raw.length !== record.samples * 4) throw new Error('Invalid raw quality PCM.');
        const pcm = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
        let squares = 0; for (const value of pcm) { if (!Number.isFinite(value)) throw new Error('Invalid raw quality PCM.'); squares += value * value; }
        if (Math.sqrt(squares / pcm.length) < .001) throw new Error('Silent raw quality PCM.');
        const wav = await clipBytes(dirname(path), record.wav), file = `${randomUUID()}.wav`, side = variant === 'candidate' ? label : label === 'A' ? 'B' : 'A';
        if (hash(wav) !== hash(waveBytes(pcm))) throw new Error('Quality WAV differs from its raw PCM.');
        await writeFile(resolve(directory, 'media', file), wav, { flag: 'wx' }); sample[side] = { file, sha256: hash(wav), bytes: wav.length };
      }
      packet.samples.push(sample);
    }
  }
  for (let i = packet.samples.length - 1; i > 0; i--) { const j = randomInt(i + 1); [packet.samples[i], packet.samples[j]] = [packet.samples[j], packet.samples[i]]; }
  packet.blindingKeyCommitment = hash(JSON.stringify(key));
  const bytes = Buffer.from(`${JSON.stringify(packet, null, 2)}\n`), packetSha256 = hash(bytes); key.packetSha256 = packetSha256;
  assessVoiceListening(packet, key, [], packetSha256);
  await readQualityFreeze(root, freezePath);
  await writeFile(resolve(directory, 'packet.json'), bytes, { flag: 'wx' });
  await writeFile(resolve(directory, 'private-key.json'), `${JSON.stringify(key, null, 2)}\n`, { flag: 'wx' });
  await writeFile(resolve(directory, 'review.html'), createVoiceReviewHtml(packet, packetSha256), { flag: 'wx' });
  return { directory, pairs: packet.samples.length, packetSha256, status: 'human reviews pending' };
}

export async function readVoiceReviewPacket(root, directory) {
  const bytes = await readFile(resolve(directory, 'packet.json')), packet = JSON.parse(bytes), key = await json(resolve(directory, 'private-key.json'));
  const { packetSha256: _packetSha256, ...committedKey } = key;
  if (packet.blindingKeyCommitment !== hash(JSON.stringify(committedKey))) throw new Error('Original blinding key changed after the packet was frozen.');
  if (packet.freezeSha256 !== hash(await readFile(key.freezePath)) || packet.protocolSha256 !== hash(await readFile(protocolPath))) throw new Error('Voice freeze or protocol changed.');
  const freeze = await readQualityFreeze(root, key.freezePath);
  for (const sample of packet.samples) {
    const id = sample.id.split(':').at(-1);
    if (JSON.stringify(sample.intendedSpeech) !== JSON.stringify(freeze.expectedSpoken[id])) throw new Error('Intended spoken wording differs from the independent freeze.');
  }
  for (const report of key.reports) {
    const bytes = await readFile(report.path);
    if (hash(bytes) !== report.sha256) throw new Error('Original quality report changed.');
    for (const entry of JSON.parse(bytes).cases) for (const record of [entry.candidate, entry.legacy]) {
      await clipBytes(dirname(report.path), record.raw); await clipBytes(dirname(report.path), record.wav);
    }
  }
  for (const sample of packet.samples) for (const label of ['A', 'B']) await clipBytes(resolve(directory, 'media'), sample[label]);
  const packetSha256 = hash(bytes); assessVoiceListening(packet, key, [], packetSha256);
  return { packet, key, packetSha256, packagedBuild: freeze.packagedBuild, keySha256: hash(await readFile(resolve(directory, 'private-key.json'))) };
}

export async function evaluateVoiceReceipt(root, receiptPath) {
  const receipt = await json(receiptPath), inputs = await readVoiceReviewPacket(root, receipt.directory), responses = [];
  if (receipt.schemaVersion !== 1 || receipt.keySha256 !== inputs.keySha256 || receipt.packetSha256 !== inputs.packetSha256 || !Array.isArray(receipt.originalResponses)) throw new Error('Voice review provenance differs.');
  for (const original of receipt.originalResponses) { const bytes = await readFile(original.path); if (hash(bytes) !== original.sha256) throw new Error('Original voice response changed.'); responses.push(JSON.parse(bytes)); }
  return { ...assessVoiceListening(inputs.packet, inputs.key, responses, inputs.packetSha256), packagedBuild: inputs.packagedBuild };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values: v } = parseArgs({ options: { prepare: { type: 'boolean' }, freeze: { type: 'string' }, report: { type: 'string', multiple: true },
    packet: { type: 'string' }, review: { type: 'string', multiple: true }, output: { type: 'string' } } });
  if (!v.output) throw new Error('Select a new --output directory or receipt.');
  if (v.prepare) console.log(JSON.stringify(await prepareVoiceReviews(process.cwd(), resolve(v.freeze), v.report ?? [], resolve(v.output))));
  else {
    const directory = resolve(v.packet), inputs = await readVoiceReviewPacket(process.cwd(), directory), originals = [];
    for (const path of v.review ?? []) { const bytes = await readFile(path); originals.push({ path: resolve(path), sha256: hash(bytes) }); }
    const receipt = { schemaVersion: 1, directory, packetSha256: inputs.packetSha256, keySha256: inputs.keySha256, originalResponses: originals };
    await writeFile(v.output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    const result = await evaluateVoiceReceipt(process.cwd(), resolve(v.output)); console.log(JSON.stringify(result));
    if (result.status !== 'qualified') process.exitCode = 1;
  }
}
