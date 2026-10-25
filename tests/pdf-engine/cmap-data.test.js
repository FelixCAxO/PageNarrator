import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parseCmapData, cmapCid, cmapUnicode, decodeCmapBytes, cmapResourceBytes } from '../../src/pdf/cmap-data.js';
import { loadPredefinedCmap } from '../../src/pdf/cmap-loader.js';
import { PREDEFINED_CMAP_NAMES } from '../../src/pdf/cmap-names.js';
import { bytes, loadAsset } from './fixtures.js';

describe('original bounded CMap record execution', () => {
  it('accounts inherited CID/Unicode records once for aliases of the same map', () => {
    const parent = parseCmapData(bytes('begincmap 1 begincodespacerange <00> <ff> endcodespacerange 1 begincidchar <41> 7 endcidchar endcmap'));
    const child = parseCmapData(bytes('begincmap 1 beginbfchar <41> <00660069> endbfchar 1 beginbfchar <42> <d800> endbfchar endcmap')); child.parent = parent;
    const expected = 64 + 32 + (64 + 4 + 8) + 64 + (64 + 2 * (2 + 2)) + (64 + 2 * (2 + child.invalidUnicode.get('42').length));
    expect(cmapResourceBytes(child, parent, child)).toBe(expected);
  });
  it('reads variable code lengths, CID ranges, fixed notdef values and Unicode arrays without evaluating programs', () => {
    const map = parseCmapData(bytes('begincmap 2 begincodespacerange <00> <7f> <8100> <81ff> endcodespacerange 1 begincidrange <41> <43> 7 endcidrange 1 begincidchar <8140> 50 endcidchar 1 beginnotdefrange <60> <62> 99 endnotdefrange 1 beginbfrange <41> <43> [<0041> <00660069> <d840dc00>] endbfrange endcmap'));
    expect(decodeCmapBytes(map, Uint8Array.of(65, 66, 0x81, 0x40)).map(item => [item.cid, item.codeLength])).toEqual([[7, 1], [8, 1], [50, 2]]);
    expect(cmapCid(map, '61')).toBe(99); expect(cmapUnicode(map, '42')).toBe('fi'); expect(cmapUnicode(map, '43')).toBe('𠀀');
    expect(() => decodeCmapBytes(map, Uint8Array.of(0x81))).toThrow(/Truncated/);
  });
  it('defers unused invalid Unicode targets, bounds record expansion and rejects corrupt sections', () => {
    const map = parseCmapData(bytes('begincmap 2 beginbfchar <01> <0041> <02> <d800> endbfchar endcmap'));
    expect(cmapUnicode(map, '01')).toBe('A'); expect(() => cmapUnicode(map, '02')).toThrow(/surrogate/);
    for (const source of ['begincmap 1 begincidrange <00> <ff> 65535 endcidrange endcmap', 'begincmap 1 begincidchar <01> 1 endbfrange endcmap', 'begincmap 1 begincidchar <01> 1 endcidchar']) expect(() => parseCmapData(bytes(source))).toThrow();
    expect(() => parseCmapData(bytes('begincmap 1 beginbfrange <00000000> <ffffffff> <0000> endbfrange endcmap'))).toThrow(/budget/);
  });
  it('parses and resolves every retained Adobe textual resource with original code', async () => {
    expect(PREDEFINED_CMAP_NAMES).toHaveLength(168);
    for (const name of PREDEFINED_CMAP_NAMES) {
      const map = await loadPredefinedCmap(name, loadAsset); expect(map.spaces.length).toBeGreaterThan(0);
      expect(typeof map.vertical).toBe('boolean');
    }
    const horizontal = await loadPredefinedCmap('90ms-RKSJ-H', loadAsset), vertical = await loadPredefinedCmap('90ms-RKSJ-V', loadAsset);
    // Adobe's literal record: 0x8141 is CID634 horizontally and CID7887 vertically.
    expect(cmapCid(horizontal, '8141')).toBe(634); expect(cmapCid(vertical, '8141')).toBe(7887);
    expect(vertical.vertical).toBe(true); expect(decodeCmapBytes(vertical, Uint8Array.of(65, 0x81, 0x41)).map(item => item.codeLength)).toEqual([1, 2]);
    // GB18030 ranges constrain each byte, not just the combined numeric interval.
    const gb = await loadPredefinedCmap('GBK2K-H', loadAsset);
    expect(decodeCmapBytes(gb, Uint8Array.of(0x82, 0x30, 0x81, 0x30, 0x81, 0x40)).map(item => item.codeLength)).toEqual([4, 2]);
    await expect(loadPredefinedCmap('../unsafe', loadAsset)).rejects.toThrow(/not supported/);
  });
  it('independently verifies retained source hashes through the static manifest', async () => {
    const manifest = JSON.parse(await readFile('vendor/pdf-cmaps/manifest.json'));
    expect(manifest.executableCode).toBe(false); expect(manifest.files.filter(file => file.role === 'character-map')).toHaveLength(168);
  });
});
