import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORIGINAL_RUNTIME_FILES, verifyOriginalEngineFiles } from './lib/release-engine-files.mjs';

export const DEFAULT_RELEASE_ARTIFACT_BUDGETS = Object.freeze({
  rawBuildBytes: 200 * 1024 * 1024,
  zipBytes: 150 * 1024 * 1024,
});

export const REQUIRED_RELEASE_FILES = [
  'manifest.json',
  'legal/Apache-2.0.txt',
  'legal/GPL-3.0.txt',
  'legal/THIRD_PARTY_NOTICES.txt',
  'legal/CMUdict-LICENSE.txt',
  'legal/Pronunciation-DATA-NOTICE.txt',
  'legal/Adobe-CMap-Resources-LICENSE.txt',
  'legal/Adobe-PDF-Mapping-LICENSE.txt',
  'legal/Adobe-Glyph-List-LICENSE.txt',
  'legal/Unicode-LICENSE.txt',
  'legal/IETF-Stringprep-NOTICE.txt',
  'legal/Vite-MIT.txt',
  'legal/Font-Awesome-LICENSE.txt',
  'legal/MarVoSym-OFL.txt',
  'legal/PDF-Symbols-NOTICE.txt',
  'src/content.js',
  'src/pdf-viewer.html',
  ...ORIGINAL_RUNTIME_FILES.map(file => file.path),
  'assets/pdf-data/manifest.json',
  'assets/pdf-cmaps/manifest.json',
  'assets/ocr/models.json',
  'assets/ocr/tiny-det.onnx',
  'assets/ocr/small-rec.onnx',
  'assets/ocr/uvdoc.onnx',
  'assets/ocr/english-lstm.json',
  'assets/ocr/english-lstm-COPYING.txt',
  'assets/ocr/english-lstm-LICENSE.txt',
  'voice-packs/selected-manifest.json',
  '_locales/en/messages.json',
];

export const RELEASE_PACKAGE_CLEAN_ASSERTIONS = Object.freeze([
  'no sourcemaps',
  'no bundled built-in voice data',
  'no retired custom voice runtime',
  'manifest COOP/COEP isolation present',
  'no manifest remote-code CSP',
  'no CDN fallbacks',
  'no remote code loaders',
  'no eval',
  'no bundled script interpreter',
  'no version mismatch',
  'GPL-3.0 license and retained-data notices present',
  'original executable artifacts match checked source artifacts and import no runtime',
  'retired executable runtimes absent',
]);

const REQUIRED_MANIFEST_POLICIES = Object.freeze([
  ['cross_origin_embedder_policy', { value: 'credentialless' }],
  ['cross_origin_opener_policy', { value: 'same-origin' }],
]);
const BUNDLED_VOICE_DATA_PATTERN = /^voice-packs\/(?!selected-manifest\.json$)/i;
const SCRIPT_FILE_PATTERN = /\.(js|mjs)$/i;
const RETIRED_EXECUTABLE_PATH = /^(?:onnx\/|assets\/pdfjs\/|assets\/pdf\.worker\.mjs$|assets\/transformers[^/]*\.js$|assets\/phonemizer\/(?:espeak\.wasm|provenance\.json)$|assets\/ocr\/(?:worker\.min\.js|tesseract[^/]*|eng\.traineddata\.gz)$)/i;
const BLOCKED_REMOTE_RUNTIME_FALLBACKS = [
  { label: 'jsDelivr CDN fallback', pattern: /https:\/\/cdn\.jsdelivr\.net/i },
  { label: 'unpkg CDN fallback', pattern: /https:\/\/unpkg\.com/i },
  { label: 'Kokoro remote voice fetch', pattern: /https:\/\/huggingface\.co\/onnx-community\/Kokoro-82M-v1\.0-ONNX\/resolve\/main\/voices\/\$\{[^}]+}\.bin[\s\S]{0,500}fetch\(/i },
];
const BLOCKED_REMOTE_CODE_LOADERS = [
  { label: 'remote dynamic import', pattern: /\bimport\s*\(\s*["'`]https?:\/\//i },
  { label: 'remote worker script', pattern: /\bnew\s+(?:Shared)?Worker\s*\(\s*["'`]https?:\/\//i },
  { label: 'remote importScripts script', pattern: /\bimportScripts\s*\(\s*["'`]https?:\/\//i },
  { label: 'remote executable-code URL', pattern: /https?:\/\/[^\s"'`<>]*\.(?:m?js|wasm)(?=[?#"'`])/i },
  { label: 'dynamic code compiler', pattern: /\bnew\s+Function\s*\(/ },
];
// A packaged interpreter can run code strings the extension never shipped, which the Chrome Web
// Store remote-code policy treats like remote code. PDF.js brings QuickJS for its scripting sandbox.
const BLOCKED_SCRIPT_INTERPRETERS = [
  { label: 'QuickJS JavaScript interpreter', pattern: /quickjs/i },
];

export function findScriptInterpreter(filePath, source = '') {
  return BLOCKED_SCRIPT_INTERPRETERS.find(({ pattern }) => pattern.test(filePath) || pattern.test(source))?.label || null;
}

export async function assertReleasePackage(packageDir, options = {}) {
  const checkedPath = resolve(packageDir);
  if (!existsSync(checkedPath) || !statSync(checkedPath).isDirectory()) {
    throw new Error(`Release package directory does not exist: ${checkedPath}`);
  }

  for (const filePath of REQUIRED_RELEASE_FILES) {
    const absolutePath = resolve(checkedPath, filePath);
    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
      throw new Error(`Missing required release file: ${filePath}`);
    }
  }

  const files = listFiles(checkedPath);
  const privateFile = files.find((path) => /(^|\/)(?:\.env(?:\..*)?|\.dev\.vars.*|[^/]+\.(?:pem|key|p12))$/i.test(path));
  if (privateFile) throw new Error(`Release package contains a private configuration or key file: ${privateFile}`);
  const retiredRuntime = files.find((filePath) => /^(?:onnx\/chatterbox\/|assets\/(?:local-voice|custom-voice)[^/]*\.js$)/i.test(filePath));
  if (retiredRuntime) throw new Error(`Release package contains retired custom voice runtime: ${retiredRuntime}`);
  const retiredEngine = files.find(path => RETIRED_EXECUTABLE_PATH.test(path));
  if (retiredEngine) throw new Error(`Release package contains retired executable runtime: ${retiredEngine}`);
  verifyOriginalEngineFiles(checkedPath, files);
  const sourcemap = files.find((filePath) => filePath.endsWith('.map'));
  if (sourcemap) {
    throw new Error(`Release package must not contain .map files: ${sourcemap}`);
  }

  const bundledVoiceData = files.find((filePath) => BUNDLED_VOICE_DATA_PATTERN.test(filePath));
  if (bundledVoiceData) {
    throw new Error(`Release package must not contain built-in voice data: ${bundledVoiceData}`);
  }

  const packageVersion = options.packageVersion || readPackageVersion();
  const manifest = JSON.parse(readFileSync(resolve(checkedPath, 'manifest.json'), 'utf8'));
  if (manifest.version !== packageVersion) {
    throw new Error(`manifest.version ${manifest.version} must match package.json version ${packageVersion}`);
  }
  assertManifestIsolation(manifest);
  assertManifestCsp(manifest);
  assertManifestReferences(checkedPath, manifest);

  const budgets = { ...DEFAULT_RELEASE_ARTIFACT_BUDGETS, ...(options.budgets || {}) };
  const metrics = assertArtifactBudgets(checkedPath, files, budgets, options);

  const namedInterpreter = files.find((filePath) => findScriptInterpreter(filePath));
  if (namedInterpreter) {
    throw new Error(`Release package must not bundle a script interpreter (${findScriptInterpreter(namedInterpreter)}): ${namedInterpreter}`);
  }

  for (const filePath of files.filter((candidate) => SCRIPT_FILE_PATTERN.test(candidate))) {
    const source = readFileSync(resolve(checkedPath, filePath), 'utf8');
    if (source.includes('datafile_js/espeakng.worker.data')) {
      throw new Error('Release package contains the opaque upstream phonemizer runtime');
    }
    if (source.includes('eval(')) {
      throw new Error(`Release package script must not contain eval(: ${filePath}`);
    }
    const interpreter = findScriptInterpreter(filePath, source);
    if (interpreter) {
      throw new Error(`Release package must not bundle a script interpreter (${interpreter}): ${filePath}`);
    }
    const blockedFallback = BLOCKED_REMOTE_RUNTIME_FALLBACKS.find(({ pattern }) => pattern.test(source));
    if (blockedFallback) {
      throw new Error(`Release package script contains blocked remote runtime fallback (${blockedFallback.label}): ${filePath}`);
    }
    const blockedLoader = BLOCKED_REMOTE_CODE_LOADERS.find(({ pattern }) => pattern.test(source));
    if (blockedLoader) {
      throw new Error(`Release package script contains blocked remote code loader (${blockedLoader.label}): ${filePath}`);
    }
  }

  return { ok: true, checkedPath, metrics, assertions: RELEASE_PACKAGE_CLEAN_ASSERTIONS };
}

function assertManifestIsolation(manifest) {
  for (const [policyName, expected] of REQUIRED_MANIFEST_POLICIES) {
    const actual = manifest?.[policyName];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${policyName} must be ${JSON.stringify(expected)}`);
    }
  }
}

function assertManifestCsp(manifest) {
  const extensionPagesCsp = String(manifest?.content_security_policy?.extension_pages || '');
  if (/\bhttps?:\/\//i.test(extensionPagesCsp) || /(^|[\s;])'unsafe-eval'(?=$|[\s;])/i.test(extensionPagesCsp)) {
    throw new Error('Manifest extension_pages CSP contains blocked remote-code source');
  }
}

function assertManifestReferences(root, manifest) {
  for (const filePath of collectManifestFileReferences(manifest)) {
    const absolutePath = resolve(root, filePath);
    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
      throw new Error(`Manifest references missing file: ${filePath}`);
    }
  }
}

function collectManifestFileReferences(manifest) {
  const refs = new Set();
  addPath(refs, manifest.background?.service_worker);
  addPath(refs, manifest.action?.default_popup);
  addPath(refs, manifest.side_panel?.default_path);

  for (const path of Object.values(manifest.icons || {})) addPath(refs, path);
  for (const path of Object.values(manifest.action?.default_icon || {})) addPath(refs, path);

  for (const script of manifest.content_scripts || []) {
    for (const path of script.js || []) addPath(refs, path);
    for (const path of script.css || []) addPath(refs, path);
  }

  for (const resourceSet of manifest.web_accessible_resources || []) {
    for (const path of resourceSet.resources || []) {
      if (!String(path).includes('*')) addPath(refs, path);
    }
  }

  return [...refs].sort();
}

function addPath(refs, filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return;
  refs.add(filePath.replace(/\\/g, '/'));
}

function assertArtifactBudgets(root, files, budgets, options = {}) {
  const zipBytes = typeof options.measureZipBytes === 'function' ? Number(options.measureZipBytes(root)) : null;
  if (isOverBudget(zipBytes, budgets.zipBytes)) {
    throw new Error(`zip size ${zipBytes} exceeds budget ${budgets.zipBytes}`);
  }

  const rawBuildBytes = totalFileBytes(root, files);
  if (isOverBudget(rawBuildBytes, budgets.rawBuildBytes)) {
    throw new Error(`raw release size ${rawBuildBytes} exceeds budget ${budgets.rawBuildBytes}`);
  }

  return {
    rawBuildBytes,
    zipBytes,
  };
}

function totalFileBytes(root, files) {
  return files.reduce((total, filePath) => total + statSync(resolve(root, filePath)).size, 0);
}

function isOverBudget(actual, budget) {
  return Number.isFinite(actual) && Number.isFinite(Number(budget)) && actual > Number(budget);
}

function readPackageVersion() {
  const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
  return packageJson.version;
}

function listFiles(root) {
  const files = [];
  walk(root, files, root);
  return files.sort();
}

function walk(directory, files, root) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      walk(absolutePath, files, root);
      continue;
    }
    if (entry.isFile()) {
      files.push(relative(root, absolutePath).split(sep).join('/'));
    }
  }
}

async function main() {
  const packageDir = process.argv[2];
  if (!packageDir) {
    throw new Error('Usage: node scripts/assert-release-package.mjs <package-dir>');
  }

  const result = await assertReleasePackage(packageDir);
  console.log(`Release package verified: ${result.checkedPath}`);
  console.log(`Raw build size: ${result.metrics.rawBuildBytes} bytes`);
  if (Number.isFinite(result.metrics.zipBytes)) {
    console.log(`Zip size: ${result.metrics.zipBytes} bytes`);
  }
  console.log('Package assertions:');
  for (const assertion of result.assertions) {
    console.log(`- ${assertion}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
