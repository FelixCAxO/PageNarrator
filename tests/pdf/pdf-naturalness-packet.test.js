// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const driver = readFileSync(new URL('../../scripts/run-pdf-acceptance.mjs', import.meta.url), 'utf8');
const root = path.resolve('unit-naturalness-root');
// Evaluate only the real writer/generator function bodies with authored dependencies.
// No target runner imports, PDFs, models, filesystem writes or human ratings occur.
function writer(generate, mkdir, writeFile) {
  const body = driver.slice(driver.indexOf('export async function writePdfNaturalnessPacket('), driver.indexOf('\nasync function loadVerifiedPdf('))
    .replace('export async function ', 'async function ');
  return new Function('generatePdfNaturalnessPacket', 'path', 'ROOT_DIR', 'NATURALNESS_PACKET_PATH', 'mkdir', 'writeFile', `${body}; return writePdfNaturalnessPacket;`)(
    generate, path, root, path.join(root, 'unit-legacy-packet.json'), mkdir, writeFile,
  );
}
const authored = [{ passageId: 'unit-passage', transcript: 'A unit transcript.', transcriptSha256: 'a'.repeat(64), categories: ['ltr'] }];

describe('text naturalness packet output', () => {
  it.each(['original', 'pdfjs-oracle'])('writes the default %s artifact with exclusive creation', async backend => {
    const generate = vi.fn(async () => authored), mkdir = vi.fn(), writeFile = vi.fn();
    const packet = await writer(generate, mkdir, writeFile)({ backend });
    expect(generate).toHaveBeenCalledExactlyOnceWith({ backend, benchmark: 'historical-v1', goldPath: undefined });
    expect(mkdir).toHaveBeenCalledExactlyOnceWith(path.join(root, 'artifacts'), { recursive: true });
    expect(writeFile).toHaveBeenCalledExactlyOnceWith(path.join(root, 'artifacts', `pdf-naturalness-${backend}.json`), `${JSON.stringify(packet, null, 2)}\n`, { flag: 'wx' });
    expect(packet.passages).toBe(authored); expect(packet.backend).toBe(backend);
  });
  it('honors an explicit output path without changing the packet return shape', async () => {
    const generate = vi.fn(async () => authored), mkdir = vi.fn(), writeFile = vi.fn();
    const outputFile = path.join('unit-output', 'review.json');
    const packet = await writer(generate, mkdir, writeFile)({ backend: 'original', outputFile });
    expect(Object.keys(packet).sort()).toEqual(['backend', 'passages', 'rubric']);
    expect(mkdir).toHaveBeenCalledExactlyOnceWith(path.dirname(path.resolve(outputFile)), { recursive: true });
    expect(writeFile.mock.calls[0][0]).toBe(path.resolve(outputFile)); expect(writeFile.mock.calls[0][2]).toEqual({ flag: 'wx' });
  });
  it('preserves an existing output and propagates its exclusive-create failure', async () => {
    const exists = Object.assign(new Error('unit output exists'), { code: 'EEXIST' });
    const generate = vi.fn(async () => authored), mkdir = vi.fn(), writeFile = vi.fn(async () => { throw exists; });
    await expect(writer(generate, mkdir, writeFile)({ backend: 'original', outputFile: 'unit-existing.json' })).rejects.toBe(exists);
    expect(writeFile).toHaveBeenCalledTimes(1); expect(writeFile.mock.calls[0][2]).toEqual({ flag: 'wx' });
  });
  it('forwards the existing CLI output selection to the packet writer', async () => {
    const start = driver.indexOf("  if (process.argv.includes('--write-naturalness-packet'))");
    const branch = `${driver.slice(start, driver.indexOf('  } else {', start))}  }`;
    const process = { argv: ['node', 'unit-script', '--write-naturalness-packet'], stdout: { write: vi.fn() } };
    const write = vi.fn(async () => ({ passages: authored }));
    await new Function('process', 'backend', 'benchmark', 'outputFile', 'writePdfNaturalnessPacket', `return (async () => { ${branch} })();`)(process, 'original', 'historical-v1', 'unit-output.json', write);
    expect(write).toHaveBeenCalledExactlyOnceWith({ backend: 'original', benchmark: 'historical-v1', outputFile: 'unit-output.json' });
  });
  it('hashes the exact case-preserving transcript shown to reviewers', async () => {
    const body = driver.slice(driver.indexOf('export async function generatePdfNaturalnessPacket('), driver.indexOf('\nexport function selectPdfNaturalnessPassage('))
      .replace('export async function ', 'async function ');
    const transcript = 'US readers pause. us readers continue.', engine = { unit: true };
    const hash = value => createHash('sha256').update(value).digest('hex');
    const generate = new Function('loadPdfAcceptanceBackend', 'configurePdfWorker', 'PDF_ACCEPTANCE_BENCHMARK', 'PDF_NATURALNESS_SAMPLE',
      'loadVerifiedPdf', 'readBenchmarkPage', 'getProductionPageText', 'selectPdfNaturalnessPassage', 'sha256', 'normalizeText', `${body}; return generatePdfNaturalnessPacket;`)(
      vi.fn(async () => ({ engine })), vi.fn(), [{ id: 'unit-source', pageNumber: 1 }], [{ id: 'unit-passage', pdfId: 'unit-source', categories: ['ltr'] }],
      vi.fn(async () => new Uint8Array([1])), vi.fn(async () => ({ unit: true })), vi.fn(async () => ({ speech: transcript })),
      vi.fn(() => transcript), hash, value => value.toLowerCase(),
    );
    const result = await generate({ backend: 'original' });
    expect(result).toEqual([{ passageId: 'unit-passage', transcript, transcriptSha256: hash(transcript), categories: ['ltr'] }]);
    expect(result[0].transcriptSha256).not.toBe(hash(transcript.toLowerCase()));
    const start = driver.indexOf('    evaluatedPages.push({');
    const statement = driver.slice(start, driver.indexOf('\n    });', start) + '\n    });'.length);
    const currentHash = new Function('record', 'pageText', 'checkpointResult', 'narrationErrors', 'narration', 'sha256', 'normalizeText', 'selectPdfNaturalnessPassage',
      `const evaluatedPages = []; ${statement}; return evaluatedPages[0].naturalnessTranscriptHash;`)(
      { id: 'unit-source', source: 'unit', sha256: 'a'.repeat(64), pageNumber: 1, categories: ['ltr'] }, { speech: transcript },
      { passed: true, failedCheckpoint: null }, 0, transcript.toLowerCase(), hash, value => value.toLowerCase(), () => transcript,
    );
    expect(currentHash).toBe(result[0].transcriptSha256);
  });
});
