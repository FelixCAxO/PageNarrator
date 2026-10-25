import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertReleasePackage } from './assert-release-package.mjs';
import { packageRelease } from './package-release.mjs';
import { releaseGateWaiver } from './lib/release-policy.mjs';

const configPath = new URL('../config/verification-gates.json', import.meta.url);
const modulePath = fileURLToPath(import.meta.url);

function usage(gates = {}) {
  const names = Object.keys(gates).sort().join(', ');
  return `Usage: node scripts/run-verification-gate.mjs <gate> [--list]\nAvailable gates: ${names}`;
}

function readGates() {
  return JSON.parse(readFileSync(configPath, 'utf8'));
}

export function verificationSteps(gateName, commands, version) {
  return commands.map((entry) => {
    const step = typeof entry === 'string' ? { command: entry } : entry;
    if (!step || typeof step.command !== 'string' || !step.command.trim()
      || step.gateId !== undefined && typeof step.gateId !== 'string') throw new Error(`Invalid command in verification gate ${gateName}.`);
    return { ...step, waiver: gateName === 'release' ? releaseGateWaiver(step.gateId, version) : null };
  });
}

function recordGateWaivers(gateName, version, waivers) {
  const directory = resolve('artifacts', 'verification');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${gateName}-${version}-waivers.json`), `${JSON.stringify({
    gateName, version, status: 'waived-requirements',
    scope: 'Waiver declarations only; not an overall gate result, verification or performance claim.', waivers,
  }, null, 2)}\n`);
}

export function runGateCommands(steps, { gateName, version, run = spawnSync, recordWaivers = recordGateWaivers, log = console.log } = {}) {
  const waivers = steps.filter((step) => step.waiver).map((step) => step.waiver);
  if (waivers.length) recordWaivers(gateName, version, waivers);
  for (const { command, waiver } of steps) {
    if (waiver) { log(`WAIVED [${waiver.gateId}]: ${command} (${waiver.authorizedOn}; not verified)`); continue; }
    log(`\n$ ${command}`);
    const result = run(command, { shell: true, stdio: 'inherit', env: process.env });
    if (result.error) { console.error(result.error.message); return 1; }
    if (result.signal) { console.error(`Command terminated by signal ${result.signal}: ${command}`); return 1; }
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

export function releaseEvidencePaths(version) {
  return {
    zip: join('releases', `pagenarrator-${version}.zip`),
    assertion: join('artifacts', 'release', `pagenarrator-${version}-package-assertion.txt`),
    manifest: join('artifacts', 'release', `pagenarrator-${version}-file-manifest.json`),
    packageLog: join('artifacts', 'release', `pagenarrator-${version}-package.txt`),
    sha256: join('artifacts', 'release', `pagenarrator-${version}.zip.sha256`),
    candidate: join('artifacts', 'release', `pagenarrator-${version}-candidate.json`),
  };
}

export async function writeReleaseEvidence() {
  const version = readPackageVersion();
  const paths = releaseEvidencePaths(version);
  const distDir = resolve('dist');
  mkdirSync(resolve('artifacts', 'release'), { recursive: true });

  const assertion = await assertReleasePackage(distDir);
  writeFileSync(resolve(paths.assertion), formatAssertion(assertion));

  const manifest = await packageRelease(distDir, { dryRun: true });
  writeFileSync(resolve(paths.manifest), `${JSON.stringify(manifest.files, null, 2)}\n`);

  const packaged = await packageRelease(distDir);
  writeFileSync(resolve(paths.packageLog), formatPackage(packaged));
  writeFileSync(resolve(paths.sha256), `${sha256File(paths.zip)}  ${normalizePath(paths.zip)}\n${packaged.sourceSha256}  ${normalizePath(packaged.sourcePath)}\n`);
  writeFileSync(resolve(paths.candidate), `${JSON.stringify({ ...createCandidateMetadata({
    version,
    zipSha256: sha256File(paths.zip),
  }), source_zip_sha256: packaged.sourceSha256 }, null, 2)}\n`);

  return paths;
}

export function createCandidateMetadata({
  version,
  zipSha256,
  env = process.env,
  generatedAt = new Date().toISOString(),
  resolveCommit = resolveCandidateCommitSha,
} = {}) {
  const commitSha = String(env.GITHUB_SHA || '').trim() || resolveCommit({ env });
  if (!/^[a-f0-9]{40}$/i.test(commitSha)) throw new Error('Candidate commit SHA must be a full 40-character hexadecimal value.');
  if (!/^[a-f0-9]{64}$/i.test(String(zipSha256 || '').trim())) throw new Error('Candidate ZIP SHA-256 must be a 64-character hexadecimal value.');
  return {
    version: String(version || ''),
    commit_sha: commitSha,
    workflow_run_id: String(env.GITHUB_RUN_ID || ''),
    zip_sha256: String(zipSha256 || '').trim().toLowerCase(),
    generated_at: String(generatedAt),
  };
}

export function resolveCandidateCommitSha({ env = process.env, rootDir = process.cwd() } = {}) {
  const ciSha = String(env.GITHUB_SHA || '').trim();
  if (ciSha) return ciSha;

  for (const gitCmd of ['git', 'C:\\Program Files\\Git\\cmd\\git.exe']) {
    try {
      const result = spawnSync(gitCmd, ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
        cwd: rootDir,
      });
      if (result.status === 0 && result.stdout) {
        const sha = String(result.stdout).trim();
        if (/^[a-f0-9]{40}$/i.test(sha)) return sha;
      }
    } catch { /* Try the next installed Git executable. */ }
  }

  try {
    const gitHeadPath = resolve(rootDir, '.git', 'HEAD');
    const headContent = readFileSync(gitHeadPath, 'utf8').trim();
    if (/^[a-f0-9]{40}$/i.test(headContent)) return headContent;
    if (headContent.startsWith('ref:')) {
      const refRelative = headContent.slice(4).trim();
      const refPath = resolve(rootDir, '.git', ...refRelative.split('/'));
      try {
        const refContent = readFileSync(refPath, 'utf8').trim();
        if (/^[a-f0-9]{40}$/i.test(refContent)) return refContent;
      } catch { /* The ref may be packed instead. */ }

      try {
        const packedRefs = readFileSync(resolve(rootDir, '.git', 'packed-refs'), 'utf8');
        for (const line of packedRefs.split('\n')) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('^')) {
            const [sha, ref] = trimmed.split(/\s+/);
            if (ref === refRelative && /^[a-f0-9]{40}$/i.test(sha)) {
              return sha;
            }
          }
        }
      } catch { /* Fall through to the explicit unresolved-SHA error. */ }
    }
  } catch { /* Git metadata is optional until the final resolution check. */ }

  throw new Error('Could not resolve candidate commit SHA.');
}

function readPackageVersion() {
  return JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version;
}

function formatAssertion(result) {
  const lines = [
    `Release package verified: ${result.checkedPath}`,
    `Raw build size: ${result.metrics.rawBuildBytes} bytes`,
  ];
  if (Number.isFinite(result.metrics.zipBytes)) {
    lines.push(`Zip size: ${result.metrics.zipBytes} bytes`);
  }
  lines.push('Package assertions:', ...result.assertions.map((assertion) => `- ${assertion}`));
  return `${lines.join('\n')}\n`;
}

function formatPackage(result) {
  return [
    `Created ${result.outputPath} (${result.fileCount} files)`,
    `Raw build size: ${result.rawBuildBytes} bytes`,
    `Zip size: ${result.zipBytes} bytes`,
  ].join('\n') + '\n';
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(resolve(path))).digest('hex');
}

function normalizePath(path) {
  return relative(process.cwd(), resolve(path)).split(sep).join('/');
}

async function main(argv = process.argv.slice(2)) {
  const gates = readGates();
  const [gateName, ...flags] = argv;

  if (gateName === '--release-evidence') {
    const paths = await writeReleaseEvidence();
    console.log('Wrote release evidence:');
    for (const path of Object.values(paths)) console.log(`- ${path}`);
    return 0;
  }

  if (!gateName || gateName === '--help' || gateName === '-h' || flags.includes('--help') || flags.includes('-h')) {
    console.error(usage(gates));
    return gateName ? 0 : 1;
  }

  const unknownFlag = flags.find((flag) => flag !== '--list');
  if (unknownFlag) {
    console.error(`Unknown option: ${unknownFlag}`);
    console.error(usage(gates));
    return 1;
  }

  const commands = gates[gateName];
  if (!Array.isArray(commands)) {
    console.error(`Unknown verification gate: ${gateName}`);
    console.error(usage(gates));
    return 1;
  }

  const version = readPackageVersion();
  const steps = verificationSteps(gateName, commands, version);

  if (flags.includes('--list')) {
    process.stdout.write(`${steps.map(({ command, waiver }) => waiver ? `WAIVED [${waiver.gateId}]: ${command}` : command).join('\n')}\n`);
    return 0;
  }

  return runGateCommands(steps, { gateName, version });
}

if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  main().then((status) => {
    process.exitCode = status;
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
