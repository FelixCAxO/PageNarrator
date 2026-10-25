import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const median = values => {
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** One-sided 95% Student-t confidence bound on paired log timing ratios. */
export function pairedTimings(pairs) {
  assert(pairs.length >= 2 && pairs.length <= 6);
  assert(pairs.every(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0));
  const logs = pairs.map(([a, b]) => Math.log(b / a));
  const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
  const variance = logs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (logs.length - 1);
  const critical = [null, 6.3137515148, 2.9199855804, 2.3533634348, 2.1318467863, 2.0150483733][logs.length - 1];
  const baselineMedianMs = median(pairs.map(p => p[0])), candidateMedianMs = median(pairs.map(p => p[1]));
  const upperRatio95 = Math.exp(mean + critical * Math.sqrt(variance / logs.length));
  return { pairs, baselineMedianMs, candidateMedianMs, medianChangePercent: 100 * (candidateMedianMs / baselineMedianMs - 1),
    pairedMedianDeltaMs: median(pairs.map(([a, b]) => b - a)), pairedMedianChangePercent: median(pairs.map(([a, b]) => 100 * (b / a - 1))),
    geometricMeanRatio: Math.exp(mean), upperRatio95,
    passed: candidateMedianMs <= baselineMedianMs && upperRatio95 < 1.03 };
}

function report() {
  const root = path.resolve('artifacts/omnivoice-memory');
  const load = relative => JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
  const resources = load('resources-delivery/results.json'), parity = load('parity/results.json');
  assert.equal(resources.status, 'passed');
  const performance = {}, memory = {}, nvidia = [];
  for (const engine of ['omnivoice', 'kokoro']) {
    const runs = resources.runs.filter(run => run.engine === engine);
    const pairs = [...new Set(runs.map(run => run.repeat))].map(repeat => [
      runs.find(run => run.variant === 'baseline' && run.repeat === repeat),
      runs.find(run => run.variant === 'candidate' && run.repeat === repeat),
    ]);
    assert(pairs.every(p => p.every(Boolean)), 'Incomplete resource pair');
    const rawRuns = new Map(runs.map(run => [run, JSON.parse(readFileSync(path.join(run.directory, `${engine}-1.json`), 'utf8'))]));
    for (const [baseline, candidate] of pairs) assert.deepEqual(
      rawRuns.get(candidate).diagnostics.log.filter(e => e.kind === 'chunk_play').map(e => e.speechText),
      rawRuns.get(baseline).diagnostics.log.filter(e => e.kind === 'chunk_play').map(e => e.speechText), 'Matched title/chunk workload changed');
    const narration = (run, mode) => {
      const log = rawRuns.get(run).diagnostics.log;
      const starts = log.filter(e => e.kind === 'chunks_extracted' && !e.final);
      const finishes = log.filter(e => e.kind === 'chunks_extracted' && e.final);
      const index = mode === 'cold' ? 0 : 1;
      assert.equal(starts.length, 2); assert.equal(finishes.length, 2);
      return 1000 * (finishes[index].t - starts[index].t);
    };
    for (const mode of ['cold', 'warm']) {
      performance[`${engine}-${mode}-complete-narration-after-extraction`] = pairedTimings(pairs.map(p => p.map(run => narration(run, mode))));
      performance[`${engine}-${mode}-UI-poll-completion`] = { ...pairedTimings(pairs.map(p => p.map(run => run.playback.find(r => r.mode === mode).elapsedMs))), diagnosticOnly: true };
    }
    memory[engine] = {};
    for (const phase of ['cold', 'warm', 'warm-retained']) {
      memory[engine][phase] = {};
      for (const metric of ['privateBytes', 'uniqueResidentBytes', 'dedicatedGpuBytes', 'sharedGpuBytes', 'gpuPercent']) {
        const stat = phase.endsWith('retained') ? 'last' : 'peak';
        const values = pairs.map(p => p.map(run => run.summary[phase][metric][stat]));
        const baseline = median(values.map(p => p[0])), candidate = median(values.map(p => p[1]));
        memory[engine][phase][metric] = { stat, baseline, candidate, saved: baseline - candidate, savedPercent: 100 * (1 - candidate / baseline), pairs: values };
        if (metric === 'gpuPercent') memory[engine][phase].gpuPercentMean = {
          baseline: median(pairs.map(p => p[0].summary[phase].gpuPercent.mean)), candidate: median(pairs.map(p => p[1].summary[phase].gpuPercent.mean)),
        };
      }
    }
    for (const run of runs) {
      const raw = rawRuns.get(run);
      const begin = raw.phases.find(p => p.name === 'baseline').at, cold = raw.phases.find(p => p.name === 'cold').at;
      const background = median(raw.nvidia.filter(s => s.at >= begin && s.at < cold).map(s => s.memoryMiB));
      nvidia.push({ engine, variant: run.variant, repeat: run.repeat, boardBackgroundMiB: background,
        boardPeakMiB: Math.max(...raw.nvidia.map(s => s.memoryMiB)),
        boardPeakAboveBackgroundMiB: Math.max(...raw.nvidia.map(s => s.memoryMiB)) - background,
        boardGpuPercentMean: raw.nvidia.reduce((sum, s) => sum + s.gpuPercent, 0) / raw.nvidia.length,
        boardGpuPercentPeak: Math.max(...raw.nvidia.map(s => s.gpuPercent)),
        processDedicatedPeakMiB: Math.max(raw.summary.cold.dedicatedGpuBytes.peak, raw.summary.warm.dedicatedGpuBytes.peak) / 1024 ** 2 });
    }
  }
  const repeats = [...new Set(parity.runs.map(run => run.repeat))];
  const parityPairs = repeats.map(repeat => ['baseline', 'candidate'].map(variant => parity.runs.find(run => run.repeat === repeat && run.variant === variant)));
  assert(parityPairs.length >= 5 && parityPairs.every(p => p.every(Boolean)));
  const identity = sample => [sample.sampleRate, sample.samples, sample.pcmSha256, sample.speaker];
  for (const pair of parityPairs) assert.deepEqual(pair[0].samples.map(identity), pair[1].samples.map(identity));
  performance['omnivoice-initialize'] = pairedTimings(parityPairs.map(p => p.map(run => run.initMs)));
  performance['omnivoice-initialize-and-first-PCM'] = pairedTimings(parityPairs.map(p => p.map(run => run.initMs + run.samples[0].elapsedMs)));
  for (const index of [0, 1]) performance[`omnivoice-${index ? 'continuation' : 'first'}-synthesis`] = pairedTimings(parityPairs.map(p => p.map(run => run.samples[index].elapsedMs)));
  const synthesisStageTimings = Object.fromEntries([0, 1].map(index => [index ? 'continuation' : 'first',
    Object.fromEntries(['inferenceMs', 'unmaskMs', 'decoderMs'].map(stage => {
      const baselineMedianMs = median(parityPairs.map(pair => pair[0].samples[index].timings[stage]));
      const candidateMedianMs = median(parityPairs.map(pair => pair[1].samples[index].timings[stage]));
      return [stage, { baselineMedianMs, candidateMedianMs }];
    }))]));
  const continuity = {};
  const engineSwitchResources = {};
  for (const engine of ['kokoro', 'omnivoice']) {
    const relative = `silent-handoff/${engine}/acoustic-analysis.json`;
    continuity[engine] = existsSync(path.join(root, relative)) ? load(relative) : { passed: false, failures: ['Silent rendered-output capture not completed'] };
    const resourceFile = `silent-handoff/${engine}/resources.json`;
    if (existsSync(path.join(root, resourceFile))) {
      const samples = load(resourceFile);
      const flow = load(`silent-handoff/${engine}/flow.json`);
      const start = flow.timeOrigin + 1000 * flow.diagnostics.log.find(e => e.kind === 'engine_incoming_requested').t;
      const end = flow.timeOrigin + 1000 * flow.diagnostics.log.filter(e => e.kind === 'engine_handoff').at(-1).t + 1000;
      const ram = samples.ram.filter(s => s.at >= start && s.at <= end);
      const gpu = samples.gpu.filter(s => Date.parse(s.sampledAtUtc) >= start && Date.parse(s.sampledAtUtc) <= end);
      engineSwitchResources[engine] = { scope: 'Explicit switching window through one second after the second handoff, including active/incoming model overlap and in-page capture overhead; excludes evidence export',
        committedRamPeakBytes: Math.max(...ram.map(s => s.processes.reduce((n, p) => n + p.private, 0))),
        uniqueResidentRamPeakBytes: Math.max(...ram.map(s => s.processes.reduce((n, p) => n + p.uss, 0))),
        dedicatedGpuPeakBytes: Math.max(...gpu.map(s => s.memory.reduce((n, m) => n + Number(m.jobDedicatedBytes), 0))),
        sharedGpuPeakBytes: Math.max(...gpu.map(s => s.memory.reduce((n, m) => n + Number(m.jobSharedBytes), 0))),
        samplerErrors: samples.errors };
    }
  }
  const baselineZip = path.join(root, 'baseline/pagenarrator-1.0.0.zip'), candidateZip = path.join(root, 'candidate-delivery/pagenarrator-1.0.0.zip');
  const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  for (const run of resources.runs) {
    const measured = JSON.parse(readFileSync(path.join(run.directory, 'results.json'), 'utf8'));
    assert.equal(measured.releaseZipSha256, sha(run.variant === 'baseline' ? baselineZip : candidateZip), 'Measured release identity changed');
  }
  const delivery = load('candidate-delivery/changed-files.json');
  const workerSha256 = sha(path.join(root, 'candidate-delivery/pagenarrator-1.0.0', delivery.worker));
  assert(parity.runs.filter(run => run.variant === 'candidate').every(run => run.workerSha256 === workerSha256), 'PCM trial worker differs from delivery');
  const continuityRoot = path.join(root, 'continuity-validation');
  const reportsIn = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? reportsIn(path.join(directory, entry.name)) : entry.name === 'continuity.json' ? [path.join(directory, entry.name)] : []);
  const recoveryFile = existsSync(continuityRoot) ? reportsIn(continuityRoot).find(file => JSON.parse(readFileSync(file, 'utf8')).recoverStatic) : null;
  const recovery = recoveryFile ? JSON.parse(readFileSync(recoveryFile, 'utf8')) : null;
  const reference = recovery && parityPairs[0][0].samples.find(sample => sample.request.text === recovery.jobs[1]?.text && sample.request.instruct === recovery.jobs[1]?.instruct);
  const staticRecovery = { passed: Boolean(recovery?.jobs[0]?.rejectedStaticInjection && reference
      && recovery.jobs[0].pcmSha256 === recovery.jobs[1].pcmSha256 && recovery.jobs[1].pcmSha256 === reference.pcmSha256),
    source: recoveryFile ? path.relative(root, recoveryFile) : null, baselinePcmSha256: reference?.pcmSha256,
    retriedPcmSha256: recovery?.jobs[1]?.pcmSha256 };
  const result = {
    generatedAt: new Date().toISOString(), hardware: 'Intel Core Ultra 9 285K; 64 GB RAM; NVIDIA RTX 5090 32 GB; driver 616.92',
    acceptanceComplete: false,
    unverifiedGates: ['Complete OS/device output-loopback matrix; physical output must remain silent.'],
    browserVersions: [...new Set(resources.runs.map(r => r.browserVersion))],
    modelManifest: JSON.parse(readFileSync('tests/fixtures/browser-speech-models.json', 'utf8')),
    baselineZipSha256: sha(baselineZip), candidateZipSha256: sha(candidateZip),
    sourceZipSha256: sha(path.join(root, 'candidate-delivery/pagenarrator-1.0.0-source.zip')),
    pairedResourceCandidateZipSha256: sha(candidateZip),
    initialMemoryCandidateResults: load('resources/results.json'),
    precedingPackageResourceCheck: load('final-resource-check/results.json'),
    finalPackageChangedFiles: load('candidate-delivery/changed-files.json'),
    pipelineScheduling: Object.fromEntries(['kokoro', 'omnivoice'].map(engine => [engine, load(`silent-handoff/${engine}/pipeline-analysis.json`)])),
    method: 'Alternating fresh-profile baseline/candidate pairs, engines measured serially, same pinned local model files. Six-paragraph cold read and cached repeat preserve the original title behavior. Browser physical output explicitly muted.',
    memory, performance, synthesisStageTimings, nvidia, continuity, engineSwitchResources, staticRecovery,
    candidateAllocationDiagnostics: parityPairs[0][1].samples.map(sample => ({ request: sample.request, resources: sample.resources })),
    verification: existsSync(path.join(root, 'verification.json')) ? load('verification.json') : [],
    investigation: [
      'OmniVoice logit decoding replaced iterator-based Float32Array.from conversion with indexed lookup through the identical fp16 table. Whole model arithmetic, token selection, random sequence and speaker references remain unchanged. Exact PCM and fixed five-pair synthesis timings determine the verdict.',
      'Kokoro phase correction now assembles one final graph buffer from byte views, removing two complete intermediate graph copies. It retains original and derived SHA-256 checks and phase-signature checks. Inference still parses and validates the derived graph; the redundant extra parse was removed.',
      'Shared WebGPU pipeline preparation is owned by one promise per device. Independent typed pipelines compile concurrently with unchanged shader source; OmniVoice main and decoder reuse the completed preparation. See docs/browser-engine.md, Speech work and resource reuse, for the stage-by-stage ownership audit.',
      'The baseline progress probe could end playback roughly 50 ms before native ended. The candidate fixes this truncation. Restoring those tails contributes to whole-read timing differences; no audio was trimmed or accelerated to make the comparison pass.',
    ],
    exactPcm: { passed: true, pairs: parityPairs.length, comparedSamples: parityPairs.reduce((n, p) => n + p[0].samples.length, 0),
      cases: parity.cases, source: 'parity/results.json' },
    failures: Object.entries(performance).filter(([, r]) => !r.passed && !r.diagnosticOnly).map(([name]) => `${name}: speed acceptance gate failed`),
    limitations: [
      'Silent captures measure rendered Web Audio before the OS/device. The complete physical-output loopback acceptance matrix is unverified; default speakers/headphones must remain silent.',
      'Whole-device NVIDIA readings include other applications; process-attributed Windows dedicated GPU memory remains the primary VRAM measure.',
      'PCM identity on this hardware does not establish linguistic quality across every supported language or minimum hardware requirements.',
      'Peak process memory is sampled at 100 ms; GPU counters at approximately 500 ms. Shorter transient peaks can be missed.',
      'UI poll completion includes polling jitter up to one second. Complete narration after extraction uses the production high-resolution flow timestamps and includes model preparation, synthesis and playback, while excluding extraction and toolbar interaction. Both measurements are reported.',
      'The matched warm workload means cached model files after the previous read and its normal model cleanup; it does not mean retaining a live model between completed reads.',
      'Final resource confidence bounds use five matched baseline/candidate pairs per engine, fixed before starting this cohort. Earlier measurements and failed gates remain preserved under the before-timing-fix artifacts. PCM/synthesis trials use byte-identical OmniVoice worker and numerical-runtime assets in the final package; Kokoro setup changes are checked separately against exact baseline WAVs.',
      'Unprepared buffering waits in the short/long stress workload are retained under continuity.unpreparedWaitsMs and reported separately from the explicitly ready, warm transition gate. Speech is not trimmed or crossfaded.',
      'The full manual-live, constrained-hardware and hardware-requirements release matrix was not rerun. These results are an optimization candidate evaluation, not public-release approval.',
    ],
  };
  for (const [engine, value] of Object.entries(continuity)) if (!value.passed) {
    if (value.status === 'inconclusive') result.unverifiedGates.push(`${engine}: silent output capture cannot be reliably aligned; no acoustic gap verdict`);
    else result.failures.push(`${engine}: silent continuity acceptance gate failed`);
  }
  if (!staticRecovery.passed) result.failures.push('Injected-static recovery PCM does not match the unchanged baseline, or evidence is missing');
  for (const check of result.verification) if (check.exitCode) result.failures.push(`${check.name}: repository check failed`);
  writeFileSync(path.join(root, 'report.json'), JSON.stringify(result, null, 2));
  const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const gib = value => (value / 1024 ** 3).toFixed(3);
  const memoryRows = Object.entries(memory).flatMap(([engine, phases]) => Object.entries(phases).map(([phase, metrics]) =>
    `<tr><td>${engine}</td><td>${phase}</td>${['privateBytes', 'uniqueResidentBytes', 'dedicatedGpuBytes', 'sharedGpuBytes'].map(metric => `<td>${gib(metrics[metric].baseline)} → ${gib(metrics[metric].candidate)} (${metrics[metric].savedPercent.toFixed(1)}%)</td>`).join('')}</tr>`)).join('');
  const timingRows = Object.entries(performance).map(([name, r]) => `<tr><td>${name}</td><td>${r.baselineMedianMs.toFixed(3)} → ${r.candidateMedianMs.toFixed(3)}</td><td>${r.medianChangePercent.toFixed(4)}%</td><td>${(100 * (r.upperRatio95 - 1)).toFixed(2)}%</td><td>${r.diagnosticOnly ? 'Diagnostic only' : r.passed ? 'PASS' : 'FAIL'}</td></tr>`).join('');
  const stageRows = Object.entries(synthesisStageTimings).flatMap(([phase, stages]) => Object.entries(stages).map(([name, r]) =>
    `<tr><td>${phase}</td><td>${{ inferenceMs: 'Main inference, readback and logit conversion', unmaskMs: 'Guidance and seeded token selection', decoderMs: 'Audio decoder and PCM validation' }[name]}</td><td>${r.baselineMedianMs.toFixed(2)} → ${r.candidateMedianMs.toFixed(2)}</td></tr>`)).join('');
  const gpuRows = Object.entries(memory).flatMap(([engine, phases]) => ['cold', 'warm'].map(phase => {
    const values = phases[phase];
    return `<tr><td>${engine}</td><td>${phase}</td><td>${values.gpuPercentMean.baseline.toFixed(2)} → ${values.gpuPercentMean.candidate.toFixed(2)}</td><td>${values.gpuPercent.baseline.toFixed(2)} → ${values.gpuPercent.candidate.toFixed(2)}</td></tr>`;
  })).join('');
  const switchRows = Object.entries(engineSwitchResources).map(([engine, r]) => `<tr><td>${engine} initially</td><td>${gib(r.committedRamPeakBytes)}</td><td>${gib(r.uniqueResidentRamPeakBytes)}</td><td>${gib(r.dedicatedGpuPeakBytes)}</td><td>${gib(r.sharedGpuPeakBytes)}</td></tr>`).join('');
  writeFileSync(path.join(root, 'report.html'), `<!doctype html><meta charset="utf-8"><title>OmniVoice memory and continuity comparison</title><style>body{font:16px/1.55 system-ui;max-width:1200px;margin:3rem auto;padding:0 2rem;color:#17202b}table{border-collapse:collapse;width:100%;font-size:14px}th,td{border:1px solid #ccd3db;padding:9px;text-align:left}th{background:#edf2f7}code{overflow-wrap:anywhere}li{margin:.5rem 0}</style><h1>OmniVoice memory and continuity comparison</h1><p><strong>Installable test candidate. Full acceptance remains incomplete; see the failed and unverified gates below. Physical output is muted.</strong></p><p>${esc(result.method)}</p><p>${esc(result.hardware)}; Chromium ${result.browserVersions.map(esc).join(', ')}.</p><p>Exact generated PCM: PASS, ${result.exactPcm.comparedSamples} paired requests in ${result.exactPcm.pairs} trials.</p><h2>Median process memory (GiB)</h2><p>Baseline → candidate, percentage saved. Read phases report peaks; retained phase reports the last sample.</p><table><tr><th>Engine</th><th>Phase</th><th>Committed RAM</th><th>Unique resident RAM</th><th>Dedicated VRAM</th><th>Shared GPU RAM</th></tr>${memoryRows}</table><h2>GPU utilization (%)</h2><p>Median per-trial time-weighted average and sampled peak, baseline → candidate. The NVIDIA whole-device cross-check is retained in the JSON report.</p><table><tr><th>Engine</th><th>Phase</th><th>Average</th><th>Peak</th></tr>${gpuRows}</table><h2>Where synthesis time goes</h2><p>Median milliseconds per English request. Inference includes GPU execution, CPU readback and logit conversion; it is not a GPU-only timer.</p><table><tr><th>Request</th><th>Stage</th><th>Baseline → candidate milliseconds</th></tr>${stageRows}</table><p>For the complete process, ownership and duplicate-work audit, see <a href="../../docs/browser-engine.md">Speech work and resource reuse</a>.</p><h2>Paired performance</h2><p>Acceptance requires no median slowdown and a one-sided 95% paired-log Student-t confidence bound below 3% regression.</p><table><tr><th>Measurement</th><th>Median milliseconds</th><th>Median change</th><th>95% upper regression</th><th>Gate</th></tr>${timingRows}</table><h2>Rendered speech continuity</h2>${Object.entries(continuity).map(([engine, r]) => `<p>${engine}: ${r.passed ? 'PASS' : 'FAIL'}, p95 ${r.p95AddedGapMs?.toFixed(2) ?? 'unavailable'} ms, maximum ${r.maximumAddedGapMs?.toFixed(2) ?? 'unavailable'} ms. ${esc(r.scope || '')} Largest unprepared wait: ${Math.max(0, ...(r.unpreparedWaitsMs || [])).toFixed(2)} ms.</p>`).join('')}<h2>Temporary engine-switch peaks (GiB)</h2><p>Measured separately while preparing the requested incoming engine alongside the active engine. Includes capture overhead; excludes waveform export.</p><table><tr><th>Starting engine</th><th>Committed RAM</th><th>Unique RAM</th><th>Dedicated VRAM</th><th>Shared GPU RAM</th></tr>${switchRows}</table><h2>Open gates and limits</h2><ul>${[...result.failures, ...result.unverifiedGates, ...result.investigation, ...result.limitations].map(value => `<li>${esc(value)}</li>`).join('')}</ul><h2>Install and evidence</h2><p>Extract <a href="candidate-delivery/pagenarrator-1.0.0.zip">candidate ZIP</a>, then use Chrome Extensions → Developer mode → Load unpacked and select the extracted folder.</p><p>Matching <a href="candidate-delivery/pagenarrator-1.0.0-source.zip">source ZIP</a>. Raw <a href="report.json">report data</a>, <a href="resources-delivery/results.json">resource trials</a>, <a href="parity/results.json">PCM hashes and timing trials</a>.</p><p>Baseline SHA-256: <code>${result.baselineZipSha256}</code><br>Candidate SHA-256: <code>${result.candidateZipSha256}</code></p>`);
  console.log(JSON.stringify({ memory, performance, failures: result.failures }, null, 2));
}

if (process.argv.includes('--self-test')) {
  assert.equal(pairedTimings([[100, 90], [100, 90], [100, 90], [100, 90], [100, 90]]).passed, true);
  assert.equal(pairedTimings([[100, 104], [100, 104], [100, 104], [100, 104], [100, 104]]).passed, false);
  assert.equal(pairedTimings([[100, 80], [100, 80], [100, 80], [100, 80], [100, 140]]).passed, false);
  console.log('Paired timing acceptance self-checks passed.');
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) report();
