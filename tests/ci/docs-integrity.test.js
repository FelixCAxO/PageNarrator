import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT_DIR = fileURLToPath(new URL('../..', import.meta.url));

function getAllMarkdownFiles(dir) {
  let results = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === '.cache') continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results = results.concat(getAllMarkdownFiles(fullPath));
    } else if (entry.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}

function getDocsAndReadmeFiles() {
  const docsDir = join(ROOT_DIR, 'docs');
  const readme = join(ROOT_DIR, 'README.md');
  const files = [readme, ...['CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md'].map(name => join(ROOT_DIR, name))];
  if (existsSync(docsDir)) {
    files.push(...getAllMarkdownFiles(docsDir));
  }
  return files;
}

describe('documentation integrity & synchronization', () => {
  const docFiles = getDocsAndReadmeFiles();
  const packageJson = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8'));
  const manifestJson = JSON.parse(readFileSync(join(ROOT_DIR, 'manifest.json'), 'utf8'));
  const validScripts = new Set(Object.keys(packageJson.scripts));
  const standardNpmScripts = new Set(['test', 'build', 'lint', 'typecheck', 'dev', 'start', 'ci']);

  it('contains no broken relative markdown links in docs and README', () => {
    const brokenLinks = [];

    for (const filePath of docFiles) {
      const content = readFileSync(filePath, 'utf8');
      const fileDir = dirname(filePath);
      const linkMatches = [...content.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)];

      for (const match of linkMatches) {
        const rawTarget = match[2].trim();
        if (
          rawTarget.startsWith('http://') ||
          rawTarget.startsWith('https://') ||
          rawTarget.startsWith('#') ||
          rawTarget.startsWith('mailto:')
        ) {
          continue;
        }

        let target = rawTarget;
        if (target.startsWith('file:///')) {
          target = target.replace('file:///', '');
        }
        const cleanTarget = target.split('#')[0].split('?')[0];
        if (!cleanTarget) continue;

        let resolvedTarget;
        if (cleanTarget.startsWith('/') || /^[a-zA-Z]:/.test(cleanTarget)) {
          resolvedTarget = resolve(cleanTarget);
        } else {
          resolvedTarget = resolve(fileDir, cleanTarget);
        }

        if (!existsSync(resolvedTarget)) {
          brokenLinks.push({
            file: relative(ROOT_DIR, filePath),
            link: rawTarget,
            resolved: resolvedTarget,
          });
        }
      }
    }

    expect(brokenLinks).toEqual([]);
  });

  it('references only valid, existing test files across all docs and README', () => {
    const testPathRegex = /`(tests\/[a-zA-Z0-9_\-./]+\.[cm]?[jt]s)`/g;
    const missingTestReferences = [];

    for (const filePath of docFiles) {
      const content = readFileSync(filePath, 'utf8');
      const matches = [...content.matchAll(testPathRegex)];

      for (const match of matches) {
        const testPath = match[1];
        const absolutePath = resolve(ROOT_DIR, testPath);

        if (!existsSync(absolutePath)) {
          missingTestReferences.push({
            doc: relative(ROOT_DIR, filePath),
            testPath,
          });
        }
      }
    }

    expect(missingTestReferences).toEqual([]);
  });

  it('references only valid npm scripts across all docs and README', () => {
    const npmRunRegex = /npm\s+run\s+([a-zA-Z0-9_\-:]+)/g;
    const missingScripts = [];

    for (const filePath of docFiles) {
      const content = readFileSync(filePath, 'utf8');
      const matches = [...content.matchAll(npmRunRegex)];

      for (const match of matches) {
        const scriptName = match[1];
        if (!validScripts.has(scriptName) && !standardNpmScripts.has(scriptName)) {
          missingScripts.push({
            doc: relative(ROOT_DIR, filePath),
            scriptName,
          });
        }
      }
    }

    expect(missingScripts).toEqual([]);
  });

  it('maintains consistent release version across package.json, manifest, and docs', () => {
    expect(packageJson.version).toBe(manifestJson.version);

    const architecture = readFileSync(join(ROOT_DIR, 'docs', 'project-architecture.md'), 'utf8');
    const multilingual = readFileSync(join(ROOT_DIR, 'docs', 'multilingual-tts.md'), 'utf8');
    const licenses = readFileSync(join(ROOT_DIR, 'docs', 'third-party-voice-licenses.md'), 'utf8');

    expect(multilingual).toContain(`PageNarrator ${packageJson.version}`);
    expect(licenses).toContain(`PageNarrator ${packageJson.version}`);
    expect(architecture).toContain('Chrome extension');
  });

  it('keeps project-architecture.md synced with all major architectural modules', () => {
    const architecture = readFileSync(join(ROOT_DIR, 'docs', 'project-architecture.md'), 'utf8');

    // Deployable surfaces
    expect(architecture).toContain('src/');
    expect(architecture).toContain('website/public/');
    expect(architecture).toContain('website/workers/support-mailbox.js');

    // Subsystems
    expect(architecture).toContain('PDF');
    expect(architecture).toContain('Kokoro');
    expect(architecture).toContain('offscreen');
    expect(architecture).toContain('WebGPU');
    expect(architecture).toContain('WebAssembly');
  });
});
