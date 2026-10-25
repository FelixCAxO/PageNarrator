import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { downloadTestModels } from '../../scripts/download-test-models.mjs';

const temporary = [];
const bytes = Buffer.from('pinned model fixture');
const fixtures = {
  modelId: 'test-model', revision: 'a'.repeat(40),
  files: [{ path: 'model.bin', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }],
};
async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'pn-model-fixtures-'));
  temporary.push(root);
  return root;
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it('downloads pinned bytes and reuses only verified cached files', async () => {
  const root = await scratch();
  const fetchFile = vi.fn(async () => new Response(bytes));
  const first = await downloadTestModels({ root, fixtures, fetchFile });
  expect(first.downloaded).toBe(1);
  expect(fetchFile).toHaveBeenCalledWith(`https://huggingface.co/test-model/resolve/${fixtures.revision}/model.bin`);
  expect(await readFile(join(first.directory, 'model.bin'))).toEqual(bytes);
  expect((await downloadTestModels({ root, fixtures, fetchFile })).downloaded).toBe(0);
  expect(fetchFile).toHaveBeenCalledTimes(1);
});

it('rejects corrupt downloads and preserves existing bytes without leaving a partial file', async () => {
  const root = await scratch();
  const result = await downloadTestModels({ root, fixtures, fetchFile: async () => new Response(bytes) });
  const target = join(result.directory, 'model.bin');
  await writeFile(target, 'old incomplete model');
  await expect(downloadTestModels({ root, fixtures, fetchFile: async () => new Response('corrupt') })).rejects.toThrow(/mismatch/);
  expect(await readFile(target, 'utf8')).toBe('old incomplete model');
  expect(await readdir(result.directory)).toEqual(['model.bin']);
});

it('rejects a failed download and paths outside the fixture directory', async () => {
  const root = await scratch();
  await expect(downloadTestModels({ root, fixtures, fetchFile: async () => new Response('', { status: 503 }) })).rejects.toThrow(/503/);
  await expect(downloadTestModels({ root, fixtures: { ...fixtures, files: [{ ...fixtures.files[0], path: '../outside.bin' }] } })).rejects.toThrow(/Invalid model fixture path/);
});
