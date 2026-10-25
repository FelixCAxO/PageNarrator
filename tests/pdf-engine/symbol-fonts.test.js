import { describe, expect, it } from 'vitest';
import { recognizedPdfSymbol, pdfNarrationSource } from '../../src/pdf/symbol-fonts.js';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { createPdfPageModel } from '../../src/lib/pdf-page-model.js';
import { symbolPdf } from './symbol-fixture.js';
import { options } from './fixtures.js';
const payload = async bytes => { const core = await createPdfDocumentCore(bytes, options); try { return await core.pagePayload(1); } finally { core.destroy(); } };

describe('documented font-specific nontext symbols', () => {
  it('uses official private Unicode only in the correct Font Awesome family/style', () => {
    expect(recognizedPdfSymbol('ABCDEF+FontAwesome5Brands-Regular', 'github')).toMatchObject({ text: '\uf09b', name: 'github', unicode: 'f09b', label: 'GitHub' });
    expect(recognizedPdfSymbol('FontAwesome5Free-Regular', 'envelope-open')).toMatchObject({ text: '\uf2b6' });
    expect(recognizedPdfSymbol('FontAwesome5Brands-Regular', 'uniF8D2')).toMatchObject({ name: 'orcid' });
    for (const [font, glyph] of [['OrdinaryFont', 'github'], ['FontAwesome5Free-Regular', 'github'], ['FontAwesome5Brands-Regular', 'unknownLogo'], ['FontAwesome5Brands-Regular', 'A'], ['OtherMarVoSym', 'Letter']]) expect(recognizedPdfSymbol(font, glyph)).toBeNull();
  });
  it('represents the identified non-Unicode MarVoSym Letter as an explicit object', () => {
    expect(recognizedPdfSymbol('ABCDEF+MarVoSym', 'Letter')).toMatchObject({ text: '\ufffc', unicode: null, originalEncodingCode: 66, label: 'Letter' });
    expect(recognizedPdfSymbol('MarVoSym', 'Euro')).toBeNull();
  });
  it.each(['type1', 'cff'])('retains source/paint geometry and separates recognized objects from mapped narrative text (%s)', async format => {
    const known = await payload(symbolPdf({ format, mixed: true })), unknown = await payload(symbolPdf({ format, mixed: true, family: 'OwnOrdinaryFont' }));
    expect(known.items[0].str).toBe('\uf09bA'); expect(known.items[0].recognizedSymbols).toHaveLength(1);
    expect(known.inspection).toMatchObject({ unmappedGlyphs: 0, recognizedSymbolGlyphs: 1 });
    expect(unknown.inspection).toMatchObject({ unmappedGlyphs: 1, recognizedSymbolGlyphs: 0 });
    expect(known.items[0].transform).toEqual(unknown.items[0].transform); expect(known.items[0].width).toBe(unknown.items[0].width);
    const paint = value => value.commands.filter(c => c.op === 'text').flatMap(c => c.glyphs.map(g => ({ renderText: g.renderText, x: g.x, matrix: c.matrix })));
    expect(paint(known)).toEqual(paint(unknown)); expect(createPdfPageModel(known.items).speech).toBe('A.');
    expect(known.items[0].str).toBe('\uf09bA'); // Narration must not mutate selectable source text.
  });
  it.each(['type1', 'cff'])('honors ToUnicode and ActualText over symbol inference (%s)', async format => {
    for (const settings of [{ unicode: '005A' }, { actual: 'Visible' }]) {
      const value = await payload(symbolPdf({ format, ...settings }));
      expect(value.items[0].str).toBe(settings.unicode ? 'Z' : 'Visible'); expect(value.items[0].recognizedSymbols).toBeUndefined();
      expect(value.inspection).toMatchObject({ unmappedGlyphs: 0, recognizedSymbolGlyphs: 0 });
      expect(createPdfPageModel(value.items).speech).toBe(settings.unicode ? 'Z.' : 'Visible.');
    }
    const empty = await payload(symbolPdf({ format, unicode: '' })); expect(empty.items).toEqual([]);
    expect(empty.inspection).toMatchObject({ unmappedGlyphs: 0, recognizedSymbolGlyphs: 0 }); expect(empty.commands.some(command => command.op === 'text')).toBe(true);
  });
  it.each(['type1', 'cff'])('offsets a recognized range when adjacent text commands merge (%s)', async format => {
    const value = await payload(symbolPdf({ format, mixed: 'before' })); expect(value.items).toHaveLength(1);
    expect(value.items[0].str).toBe('A\uf09b'); expect(value.items[0].recognizedSymbols[0]).toMatchObject({ start: 1, length: 1, sourceCode: 65 });
    expect(createPdfPageModel(value.items).speech).toBe('A.');
  });
  it.each(['type1', 'cff'])('keeps the non-Unicode Letter object selectable without treating it as a letter B (%s)', async format => {
    const value = await payload(symbolPdf({ format, family: 'ABCDEF+MarVoSym', glyph: 'Letter' }));
    expect(value.items[0].str).toBe('\ufffc'); expect(value.items[0].recognizedSymbols[0]).toMatchObject({ sourceCode: 65, originalEncodingCode: 66, unicode: null });
    expect(value.inspection).toMatchObject({ unmappedGlyphs: 0, recognizedSymbolGlyphs: 1 }); expect(createPdfPageModel(value.items).speech).toBe('');
    expect(value.commands.some(command => command.op === 'text')).toBe(true);
  });
  it('masks only validated metadata ranges, leaving unknown fonts, ordinary letters and unclassified private text alone', () => {
    const symbol = recognizedPdfSymbol('FontAwesome5Brands-Regular', 'github'), item = { str: `left ${symbol.text} right`, recognizedSymbols: [{ ...symbol, start: 5, length: 1 }] };
    expect(pdfNarrationSource(item)).toBe('left   right'); expect(item.str).toBe('left \uf09b right');
    for (const replacement of [{ fontFamily: 'OrdinaryFont' }, { name: 'unknown' }, { start: -1 }, { length: 2 }, { label: 'made up' }]) expect(pdfNarrationSource({ ...item, recognizedSymbols: [{ ...item.recognizedSymbols[0], ...replacement }] })).toBe(item.str);
    expect(pdfNarrationSource({ str: 'Text \ue000 remains' })).toBe('Text \ue000 remains');
  });
});
