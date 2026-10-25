import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import manifest from '../../manifest.json' with { type: 'json' };

const root = process.cwd();

function readPngHeader(relativePath) {
  const bytes = readFileSync(join(root, relativePath));
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colorType: bytes[25],
  };
}

function expectPngWithAlpha(relativePath, expectedSize) {
  const header = readPngHeader(relativePath);

  expect(header.width).toBe(expectedSize.width);
  expect(header.height).toBe(expectedSize.height);
  expect([4, 6]).toContain(header.colorType);
}

describe('icon assets', () => {
  it('uses the PageNarrator artwork for every extension icon size', () => {
    const expectedIcons = {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    };

    expect(manifest.icons).toEqual(expectedIcons);
    expect(manifest.action.default_icon).toEqual(expectedIcons);

    for (const [size, path] of Object.entries(expectedIcons)) {
      expectPngWithAlpha(path, { width: Number(size), height: Number(size) });
    }
  });

  it('keeps transparent source artwork available for stores and docs', () => {
    const transparentIcon = 'icons/PageNarrator_Icon_Transparent.png';
    const transparentIconWithText = 'icons/PageNarrator_Icon_With_Text_Transparent.png';

    expect(existsSync(join(root, transparentIcon))).toBe(true);
    expect(existsSync(join(root, transparentIconWithText))).toBe(true);
    expectPngWithAlpha(transparentIcon, { width: 1254, height: 1254 });
    expectPngWithAlpha(transparentIconWithText, { width: 1448, height: 1086 });
  });

  it('documents the canonical icon assets instead of placeholder work', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const iconDocs = readFileSync(join(root, 'docs', 'icons.md'), 'utf8');
    const docsText = `${readme}\n${iconDocs}`;

    expect(docsText).toContain('PageNarrator_Icon.png');
    expect(docsText).toContain('PageNarrator_Icon_With_Text.png');
    expect(docsText).toContain('PageNarrator_Icon_Transparent.png');
    expect(docsText).not.toContain('pro-icon-128.png');
    expect(docsText).not.toContain('generate-icons.ps1');
    expect(readme).not.toContain('- [ ] Replace placeholder icons in `manifest.json`');
  });
});
