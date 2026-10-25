#!/usr/bin/env node
import { chromium } from 'playwright';
import spawn from 'cross-spawn';
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_URLS = [
  'chrome://extensions',
  'https://en.wikipedia.org/wiki/Artificial_intelligence',
  'https://sv.wikipedia.org/wiki/Artificiell_intelligens',
  'https://de.wikipedia.org/wiki/K%C3%BCnstliche_Intelligenz',
  'https://fr.wikipedia.org/wiki/Intelligence_artificielle',
  'https://nl.wikipedia.org/wiki/Kunstmatige_intelligentie',
];
const DEFAULT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

export function parsePreviewArgs(args) {
  const parsed = {
    OutDir: '',
    LaunchUrls: [],
    Fresh: false,
    SkipBuild: false,
    RemoteDebuggingPort: '',
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('-')) {
      parsed.LaunchUrls.push(arg);
      continue;
    }

    const name = arg.replace(/^-+/, '');
    if (['Fresh', 'SkipBuild'].includes(name)) {
      parsed[name] = true;
      continue;
    }

    const value = args[index + 1] || '';
    index += 1;
    if (name === 'LaunchUrls') parsed.LaunchUrls.push(value);
    if (name === 'OutDir') parsed.OutDir = value;
    if (name === 'RemoteDebuggingPort') parsed.RemoteDebuggingPort = value;
  }

  return parsed;
}

export function createPreviewLaunchPlan({
  root = DEFAULT_ROOT,
  env = process.env,
  now = Date.now,
  options = parsePreviewArgs([]),
} = {}) {
  const outDir = options.OutDir || 'dist-preview';
  const dist = join(root, outDir);
  const launchUrls = options.LaunchUrls.length ? options.LaunchUrls : DEFAULT_URLS;
  const userDataDir = options.Fresh
    ? join(env.TEMP || env.TMP || root, `PageNarrator-preview-${now()}`)
    : join(env.LOCALAPPDATA || env.HOME || root, 'PageNarrator-preview');

  return {
    outDir,
    dist,
    launchUrls,
    userDataDir,
    launchTimeoutMs: 60000,
    buildArgs: ['run', 'build', '--', '--outDir', outDir],
    launchArgs: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...(options.RemoteDebuggingPort ? [`--remote-debugging-port=${options.RemoteDebuggingPort}`] : []),
    ],
  };
}

async function withPreviewEnvironment(values, task) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === '') delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return await task();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function runNpm(args, { cwd = DEFAULT_ROOT } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('npm', args, {
      cwd,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`Build failed with npm exit code ${code}`));
    });
    child.on('error', rejectRun);
  });
}

async function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parsePreviewArgs(argv);
  const root = DEFAULT_ROOT;
  const plan = createPreviewLaunchPlan({ root, env, options });

  await withPreviewEnvironment({
    PN_PREVIEW: '1',
    PN_OUT_DIR: plan.outDir,
  }, async () => {
    if (!options.SkipBuild) await runNpm(plan.buildArgs, { cwd: root });
  });

  if (!existsSync(plan.dist)) {
    throw new Error(`Preview build output does not exist: ${plan.dist}`);
  }

  if (options.Fresh) await rm(plan.userDataDir, { recursive: true, force: true });

  const context = await withTimeout(
    chromium.launchPersistentContext(plan.userDataDir, {
      headless: false,
      args: plan.launchArgs,
    }),
    plan.launchTimeoutMs,
    'Chromium preview launch timed out after 60 seconds.',
  );

  for (const url of plan.launchUrls) {
    const page = await context.newPage();
    await page.goto(url);
  }

  console.log(`PageNarrator preview running from ${plan.dist}`);
  console.log(`Profile: ${plan.userDataDir}`);
  console.log('Close the Chromium window to stop the preview.');

  context.on('close', () => process.exit(0));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
