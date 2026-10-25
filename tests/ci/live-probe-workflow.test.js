import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('local live TTS probe wiring', () => {
  it('keeps the lower-spec probe and requirements commands runnable locally', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

    expect(packageJson.scripts['probe:tts:lower-spec']).toBe('npm run build && npm run probe:tts:lower-spec:no-build');
    expect(packageJson.scripts['probe:tts:lower-spec:no-build']).toContain('PAGENARRATOR_TTS_PROBE_PROFILE=lower-spec');
    expect(packageJson.scripts['requirements:tts']).toBe('node scripts/summarize-tts-requirements.mjs');
    expect(packageJson.scripts['probe:tts:requirements']).toContain('PAGENARRATOR_TTS_PROBE_PROFILE=requirements');
  });

  it('keeps scored probe commands isolated; parallel profile jobs need the explicit contention mode', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const probeCommands = Object.entries(packageJson.scripts).filter(([name]) => name.startsWith('probe:'));

    for (const [, command] of probeCommands) {
      expect(command).not.toMatch(/PAGENARRATOR_TTS_PROBE_MAX_WORKERS=([2-9]|\d{2,})/);
      expect(command).not.toContain('PAGENARRATOR_TTS_PROBE_MODE=contention');
    }
  });

  it('wires the weak-hardware matrix, unit suite and measurement lock locally', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const gates = JSON.parse(readFileSync(new URL('../../config/verification-gates.json', import.meta.url), 'utf8'));

    expect(packageJson.scripts['probe:weak-hardware:no-build']).toBe('node scripts/weak-hardware/run-matrix.mjs');
    expect(packageJson.scripts['test:weak-hardware']).toBe('vitest run tests/weak-hardware');
    expect(packageJson.scripts['measurement:lock']).toBe('node scripts/weak-hardware/measurement-lock.mjs');
    expect(gates['weak-hardware']).toEqual(['npm run build', 'npm run probe:weak-hardware:no-build']);
    expect(gates.release).not.toContain('npm run probe:weak-hardware:no-build');
  });

  it('adds lower-spec PDF probe evidence without expanding the full matrix', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

    expect(packageJson.scripts['probe:tts:lower-spec-pdf']).toBe('npm run build && npm run probe:tts:lower-spec-pdf:no-build');
    expect(packageJson.scripts['probe:tts:lower-spec-pdf:no-build']).toContain('PAGENARRATOR_TTS_PROBE_PROFILE=4gb_4cpu_low_memory');
    expect(packageJson.scripts['probe:tts:lower-spec-pdf:no-build']).toContain('PAGENARRATOR_TTS_PROBE_DOCUMENTS=pdf');
    expect(packageJson.scripts['probe:tts:lower-spec-pdf:no-build']).toContain('PAGENARRATOR_TTS_PROBE_MAX_WORKERS=1');
  });

  it('keeps real-model article and PDF reads available locally', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const gates = JSON.parse(readFileSync(new URL('../../config/verification-gates.json', import.meta.url), 'utf8'));
    const realModelTest = readFileSync(new URL('../e2e/real-model-read.e2e.js', import.meta.url), 'utf8');

    expect(packageJson.scripts['test:e2e:real-model']).toBe(
      'cross-env PN_E2E_REAL_MODEL=1 playwright test --project=real-model'
    );
    expect(realModelTest).toContain("ttsPerformanceProfile: 'quality'");
    expect(realModelTest).toContain("ttsPerformanceProfile: 'auto'");
    expect(realModelTest).toContain('browserFallbackEvents(readerEngineLog)');
    expect(gates.release).toContain('npm run test:e2e:real-model -- --workers=1 --output=artifacts/release-real-model');
  });

  it('keeps the live probe wired to article and PDF documents', async () => {
    const probe = readFileSync(new URL('../live/tts-probe-settings.js', import.meta.url), 'utf8');
    const { PROBE_WORKLOADS, loadPdfWorkloadBytes } = await import('../live/tts-probe-workloads.js');

    expect(probe).toContain('getTtsProbeDocumentTypes');
    expect(probe).toContain('PROBE_WORKLOADS');
    expect(PROBE_WORKLOADS.pdf.kind).toBe('pdf');
    expect((await loadPdfWorkloadBytes(PROBE_WORKLOADS.pdf)).subarray(0, 5).toString()).toBe('%PDF-');
    expect(probe).toContain('documentType');
  });

  it('reopens a PDF before a later run, because closing the toolbar player disposes its viewer', () => {
    const runLoop = readFileSync(new URL('../live/tts-probe-runner.js', import.meta.url), 'utf8');

    expect(runLoop).toMatch(/needsFreshDocumentTarget\(documentType, \{ usedInSession: session\.usedDocumentTypes\.has\(documentType\) \}\)\)[\s\S]*reopenProbePdfDocument\(session, documentType\)/);
    expect(runLoop.indexOf('reopenProbePdfDocument(session, documentType)')).toBeLessThan(runLoop.indexOf('session.probeDocuments.find('));
    expect(runLoop.indexOf('session.usedDocumentTypes.add(documentType)')).toBeGreaterThan(runLoop.indexOf('await runProbeAttempt('));
  });

  it('keeps lower-spec probes in the local manual-live gate', () => {
    const gates = JSON.parse(readFileSync(new URL('../../config/verification-gates.json', import.meta.url), 'utf8'));
    expect(gates['manual-live']).toEqual(expect.arrayContaining([
      'npm run test:live:no-build',
      'npm run probe:tts:lower-spec:no-build',
      'npm run probe:tts:lower-spec-pdf:no-build',
      'npm run requirements:tts',
    ]));
  });

  it('keeps strict physical assessment available separately from the explicit v1 release waiver', () => {
    const gates = JSON.parse(readFileSync(new URL('../../config/verification-gates.json', import.meta.url), 'utf8'));
    expect(gates.release).toContainEqual({ command: 'npm run requirements:tts -- --fail-on-non-pass', gateId: 'physical-hardware' });
    expect(gates['manual-live']).toContain('npm run requirements:tts');

    const root = mkdtempSync(join(tmpdir(), 'pn-hardware-release-gate-'));
    try {
      mkdirSync(join(root, 'dist'));
      writeFileSync(join(root, 'dist', 'main.js'), 'candidate runtime');
      const input = join(root, 'empty-probe.json');
      const json = join(root, 'summary.json');
      const markdown = join(root, 'summary.md');
      writeFileSync(input, JSON.stringify({ attempts: [] }));
      const args = [fileURLToPath(new URL('../../scripts/summarize-tts-requirements.mjs', import.meta.url)),
        input, '--json', json, '--md', markdown];
      const diagnostic = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
      expect(diagnostic.status, diagnostic.stderr).toBe(0);
      const release = spawnSync(process.execPath, [...args, '--fail-on-non-pass'], { cwd: root, encoding: 'utf8' });
      expect(release.status, release.stderr).toBe(1);
      expect(JSON.parse(readFileSync(json, 'utf8')).launchEvidence).toMatchObject({ status: 'non-pass' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
