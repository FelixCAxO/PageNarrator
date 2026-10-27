import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = 'FelixCAxO/PageNarrator';

export function releaseExtensionAsset(release) {
  if (!/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(release.tagName)) throw new Error('Invalid release tag.');
  const name = `pagenarrator-${release.tagName.slice(1)}.zip`;
  const asset = release.assets.find(item => item.name === name);
  if (!asset || !/^sha256:[a-f0-9]{64}$/u.test(asset.digest || '')) throw new Error(`Missing ZIP or SHA-256 digest: ${name}`);
  return asset;
}

export function verifyReleaseZip(bytes, asset) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (`sha256:${sha256}` !== asset.digest) throw new Error('GitHub release ZIP checksum mismatch.');
  return sha256;
}

export function releaseTestEnvironment(extensionDir, env = process.env) {
  return { ...env, PN_E2E_EXTENSION_DIR: extensionDir, PN_E2E_REAL_MODEL: '1', PN_E2E_OMNIVOICE: '1' };
}

export function testGithubRelease([tag = 'latest', ...testArgs] = []) {
  const release = JSON.parse(execFileSync('gh', ['release', 'view', ...(tag === 'latest' ? [] : [tag]),
    '--repo', repository, '--json', 'tagName,url,assets'], { encoding: 'utf8' }));
  const asset = releaseExtensionAsset(release);
  const root = resolve('artifacts/github-release-e2e');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, `${release.tagName}-`));
  execFileSync('gh', ['release', 'download', release.tagName, '--repo', repository,
    '--pattern', asset.name, '--dir', directory], { stdio: 'inherit' });
  const zip = join(directory, asset.name);
  const sha256 = verifyReleaseZip(readFileSync(zip), asset);
  const extensionDir = join(directory, 'extension');
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath $env:PN_RELEASE_ZIP -DestinationPath $env:PN_RELEASE_EXTRACT -ErrorAction Stop'],
    { env: { ...process.env, PN_RELEASE_ZIP: zip, PN_RELEASE_EXTRACT: extensionDir }, stdio: 'inherit' });
  } else {
    execFileSync('unzip', ['-q', zip, '-d', extensionDir], { stdio: 'inherit' });
  }
  const manifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'));
  if (`v${manifest.version}` !== release.tagName) throw new Error('Extension manifest version differs from the GitHub release tag.');
  const evidence = { tag: release.tagName, url: release.url, asset: asset.name, sha256, extensionDir,
    startedAt: new Date().toISOString(), testArgs, realKokoro: true, realOmniVoice: true, status: 'running' };
  const evidencePath = join(directory, 'release-test.json');
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Testing downloaded ${release.tagName}: ${sha256}\nEvidence: ${evidencePath}`);
  const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
  const result = spawnSync(process.execPath, [cli, 'test', ...testArgs, '--workers=1', `--output=${join(directory, 'test-results')}`],
    { env: releaseTestEnvironment(extensionDir), stdio: 'inherit' });
  evidence.status = !result.error && result.status === 0 ? 'passed' : 'failed';
  writeFileSync(evidencePath, `${JSON.stringify({ ...evidence, finishedAt: new Date().toISOString(), exitCode: result.status,
    error: result.error?.message || result.signal }, null, 2)}\n`);
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = testGithubRelease(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
