import { expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const copyright = 'Copyright 2002-2019 Adobe (http://www.adobe.com/).';
const vendorPath = 'engines/vendor/pdf-glyphs';
const packagedPath = 'extension/public/legal/Adobe-Glyph-List-LICENSE.txt';

it('distributes the original AGL and Zapf copyright with their redistribution conditions', async () => {
  const vendor = await readFile(path.join(root, vendorPath, 'LICENSE.md'), 'utf8');
  const packaged = await readFile(path.join(root, packagedPath), 'utf8');
  expect(vendor).toContain(copyright);
  expect(vendor).toContain('Redistributions of source code must retain the above copyright notice,');
  expect(vendor).toContain('Redistributions in binary form must reproduce the above copyright');
  expect(packaged).toBe(vendor);
});

it('rejects a packaged glyph notice that differs from the verified source notice', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'pagenarrator-glyph-notices-'));
  try {
    await mkdir(path.join(temporary, 'tooling/scripts'), { recursive: true });
    await mkdir(path.join(temporary, 'extension/public/legal'), { recursive: true });
    await cp(path.join(root, vendorPath), path.join(temporary, vendorPath), { recursive: true });
    const script = path.join(temporary, 'tooling/scripts/import-pdf-glyphs.mjs');
    await cp(path.join(root, 'tooling/scripts/import-pdf-glyphs.mjs'), script);
    const notice = await readFile(path.join(root, packagedPath), 'utf8');
    await writeFile(path.join(temporary, packagedPath), notice);
    const run = () => spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
    const valid = run();
    expect(valid.status, valid.stderr).toBe(0);
    await writeFile(path.join(temporary, packagedPath), notice.replace(copyright, '') + '\n');
    const invalid = run();
    expect(invalid.status, 'The importer accepted an incomplete packaged copyright notice.').not.toBe(0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
