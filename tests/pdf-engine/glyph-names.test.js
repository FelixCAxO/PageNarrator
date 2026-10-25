import { describe, expect, it } from 'vitest';
import { glyphNameText, isDingbatsFont } from '../../src/pdf/type1-font.js';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { simplePdf, stream, options, loadAsset } from './fixtures.js';

describe('original Adobe glyph-name interpretation with pinned mapping data', () => {
  it('preserves official AGL scalar values and multi-scalar names', () => {
    expect(glyphNameText('Aacute')).toBe('\u00c1');
    expect(glyphNameText('Omega')).toBe('\u2126');
    expect(glyphNameText('Omegagreek')).toBe('\u03a9');
    expect(glyphNameText('dalethatafpatah')).toBe('\u05d3\u05b2');
    expect(glyphNameText('ffi')).toBe('\ufb03');
  });
  it('discards a glyph suffix before interpreting component names and Unicode scalars', () => {
    expect(glyphNameText('Aacute.swash')).toBe('\u00c1');
    expect(glyphNameText('f_f_i.alt')).toBe('ffi');
    expect(glyphNameText('uni00410301.alt')).toBe('A\u0301');
    expect(glyphNameText('u1F600')).toBe('\u{1f600}');
  });
  it('uses Zapf Dingbats mappings only in a verified Dingbats font-name context', () => {
    expect(isDingbatsFont('QEULYP+Dingbats')).toBe(true);
    expect(isDingbatsFont('ZapfDingbats')).toBe(true);
    expect(isDingbatsFont('MyDingbatsishFont')).toBe(false);
    expect(glyphNameText('a117')).toBeNull();
    expect(glyphNameText('a117', { dingbats: true })).toBe('\u2709');
    expect(glyphNameText('a120', { dingbats: true })).toBe('\u2460');
  });
  it.each(['f_unknown', 'github', 'Letter', 'envelope-open', 'orcid', 'constructor', 'uniD800', 'uniD83DDE00', 'u110000', '', undefined])('keeps unknown or invalid glyph %s unresolved', name => {
    expect(glyphNameText(name)).toBeNull();
  });
  it('maps a licensed real Dingbats CFF font to its documented envelope without changing paint aliases', async () => {
    const data = simplePdf('BT /F1 12 Tf 1 0 0 1 50 700 Tm <29> Tj ET', { font: '/Type /Font /Subtype /Type1 /BaseFont /ZapfDingbats' });
    const core = await createPdfDocumentCore(data, options);
    try {
      const payload = await core.pagePayload(1), paint = payload.commands.find(command => command.op === 'text');
      expect(payload.items[0].str).toBe('\u2709'); expect(payload.inspection.unmappedGlyphs).toBe(0);
      expect(paint.glyphs[0].renderText).toBeDefined(); expect(paint.glyphs[0].renderText).not.toBe('\u2709');
    } finally { core.destroy(); }
  });
  it('uses the normative Symbol encoding when a standard font has no embedded program', async () => {
    const core = await createPdfDocumentCore(simplePdf('BT /F1 12 Tf <414257> Tj ET', { font: '/Type /Font /Subtype /Type1 /BaseFont /Symbol' }), options);
    try {
      const payload = await core.pagePayload(1);
      expect(payload.items[0].str).toBe('\u0391\u0392\u2126');
      expect(payload.inspection.unmappedGlyphs).toBe(0);
    } finally { core.destroy(); }
  });
  it('preserves an embedded Dingbats program and explicit remapping rather than imposing standard byte positions', async () => {
    const data = simplePdf('BT /F1 12 Tf <29> Tj ET', {
      font: '/Type /Font /Subtype /Type1 /BaseFont /ZapfDingbats /FontDescriptor 6 0 R /Encoding << /Differences [41 /a120] >>',
      extra: ['<< /Type /FontDescriptor /FontName /ZapfDingbats /FontFile3 7 0 R >>', stream(await loadAsset('standard_fonts/FoxitDingbats.pfb'), '/Subtype /Type1C')]
    });
    const core = await createPdfDocumentCore(data, options);
    try {
      const payload = await core.pagePayload(1);
      expect(payload.items[0].str).toBe('\u2460');
      expect(payload.inspection.unmappedGlyphs).toBe(0);
    } finally { core.destroy(); }
  });
});
