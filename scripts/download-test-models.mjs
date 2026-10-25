import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import manifest from '../tests/fixtures/kokoro-models.json' with { type: 'json' };

async function matches(path, file) {
  try {
    if ((await stat(path)).size !== file.bytes) return false;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex') === file.sha256;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function downloadTestModels({
  fixtures = manifest,
  root = process.env.PN_KOKORO_FIXTURE_DIR || '.cache/kokoro',
  fetchFile = fetch,
} = {}) {
  const modelDir = resolve(root, fixtures.modelId);
  let downloaded = 0;
  for (const file of fixtures.files) {
    const target = resolve(modelDir, file.path);
    if (!target.startsWith(`${modelDir}/`) && !target.startsWith(`${modelDir}\\`)) {
      throw new Error(`Invalid model fixture path: ${file.path}`);
    }
    if (await matches(target, file)) continue;
    await mkdir(dirname(target), { recursive: true });
    const partial = `${target}.part`;
    try {
      const url = `https://huggingface.co/${fixtures.modelId}/resolve/${fixtures.revision}/${file.path}`;
      const response = await fetchFile(url);
      if (!response.ok || !response.body) throw new Error(`Model fixture download failed: ${file.path} (${response.status})`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
      if (!await matches(partial, file)) throw new Error(`Model fixture hash or size mismatch: ${file.path}`);
      await rename(partial, target);
      downloaded += 1;
    } finally {
      await rm(partial, { force: true });
    }
  }
  return { files: fixtures.files.length, downloaded, directory: modelDir };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  downloadTestModels().then((result) => {
    console.log(`Verified ${result.files} pinned Kokoro fixtures (${result.downloaded} downloaded): ${result.directory}`);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
