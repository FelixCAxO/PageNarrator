import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPageContracts, websiteBuildIdentity } from './smoke-production.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
export const websiteOutputDir = join(root, 'artifacts/website');

export function buildWebsite(sourceDir = join(root, 'website/public'), outputDir = websiteOutputDir) {
  const source = resolve(sourceDir), output = resolve(outputDir);
  const sourceFromOutput = relative(output, source);
  if (!sourceFromOutput || !sourceFromOutput.startsWith('..') || !relative(source, output).startsWith('..')) {
    throw new Error('Website output must be separate from the source directory.');
  }
  const pages = loadPageContracts(source)
    .filter(({ indexable, path }) => indexable || path === '/404')
    .map(({ path }) => path === '/' ? 'index.html' : `${path.slice(1)}.html`);
  const files = [...pages, '_headers', '_redirects', 'robots.txt', 'sitemap.xml',
    'favicon.ico', 'apple-touch-icon.png', 'og-image.jpg', 'assets/fonts/OFL-Newsreader.txt'];
  function collectAssets(directory, prefix = 'assets') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || /(?:^|[-_.])(?:debug|test|fixture|private)(?:[-_.]|$)/i.test(entry.name)) continue;
      const path = join(prefix, entry.name);
      if (entry.isDirectory()) collectAssets(join(source, path), path);
      else if (entry.isFile() && ['.css', '.png', '.jpg', '.webp', '.ico', '.svg', '.wav', '.woff2'].includes(extname(entry.name))) files.push(path);
    }
  }
  collectAssets(join(source, 'assets'));
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  for (const file of files) {
    mkdirSync(resolve(output, file, '..'), { recursive: true });
    cpSync(join(source, file), join(output, file));
  }
  writeFileSync(join(output, 'site-build.json'), `${JSON.stringify({ id: websiteBuildIdentity(output) })}\n`);
  files.push('site-build.json');
  return { outputDir: output, files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { files, outputDir } = buildWebsite();
  console.log(`Prepared ${files.length} public website files in ${outputDir}.`);
}
