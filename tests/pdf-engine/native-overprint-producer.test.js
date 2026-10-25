// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { simplePdf, stream, options } from './fixtures.js';

const flat = commands => commands.flatMap(command => [command, ...(command.commands ? flat(command.commands) : [])]);
const square = '0 .7 0 .3 k 0 0 20 20 re f';
async function payload(content, { states = ['/OP true /OPM 1'], extra = [], resources = '' } = {}, run = value => value) {
  const statesDictionary = states.map((_state, i) => `/G${i} ${6 + i} 0 R`).join(' ');
  const data = simplePdf(content, { page: `/Group << /S /Transparency /CS /DeviceCMYK >> /Resources << /Font << /F1 5 0 R >> /ExtGState << ${statesDictionary} >> ${resources} >>`, extra: [...states.map(state => `<< ${state} >>`), ...extra] });
  const core = await createPdfDocumentCore(data, options);
  try { return await run(await core.pagePayload(1)); } finally { core.destroy(); }
}
const paints = value => flat(value.commands).filter(command => command.op === 'paint' && command.kind !== 'n');
const texts = value => flat(value.commands).filter(command => command.op === 'text');
const unsupported = { code: 'pdf_unsupported' };

describe('direct CMYK Normal CompatibleOverprint producer scope', () => {
  it('selects a private nonzero ink token only at actual OPM1 fills', () => payload(`/G0 gs ${square}`, {}, value => {
    expect(paints(value)[0]).toMatchObject({ nativeCmykFill: [0, expect.closeTo(.7, 14), 0, expect.closeTo(.3, 14)], nativeCmykFillBlend: 'overprint-nonzero', blend: 'source-over' });
    expect(value.commands[0].blend).toBe('source-over'); expect(value.commands[0].nativeCmykFillBlend).toBeUndefined();
  }));
  it.each(['/OP true', '/OP true /OPM 0', '/OP false /OPM 1'])('keeps direct CMYK ordinary source-over for %s', state => payload(`/G0 gs ${square}`, { states: [state] }, value => expect(paints(value)[0].nativeCmykFillBlend).toBeUndefined()));
  it('retains OPM through q/Q and ordinary Form inheritance, without applying it to the Form object', async () => {
    await payload(`q /G0 gs ${square} Q /G1 gs ${square}`, { states: ['/op true /OPM 1', '/op true'] }, value => {
      expect(paints(value).map(command => command.nativeCmykFillBlend)).toEqual(['overprint-nonzero', undefined]);
    });
    await payload('/G0 gs /F Do', { resources: '/XObject << /F 7 0 R >>', extra: [stream(square, '/Subtype /Form /BBox [0 0 20 20]')] }, value => expect(paints(value)[0].nativeCmykFillBlend).toBe('overprint-nonzero'));
  });
  it.each([true, false])('inherits overprint in a same-CMYK group with I=%s but does not tag its composition', isolated => payload('/G0 gs /F Do', {
    resources: '/XObject << /F 7 0 R >>', extra: [stream(square, `/Subtype /Form /BBox [0 0 20 20] /Group << /S /Transparency /I ${isolated} >>`)],
  }, value => { expect(paints(value)[0].nativeCmykFillBlend).toBe('overprint-nonzero'); expect(flat(value.commands).filter(c => c.op === 'group').every(c => c.blend === 'source-over')).toBe(true); }));
  it('honours OP/op distinction and OP-to-op fallback at the actual painted channel', async () => {
    await payload('/G0 gs 0 .7 0 .3 k 0 .7 0 .3 K 0 0 20 20 re f 30 0 20 20 re S', { states: ['/OP true /op false /OPM 1'] }, value => {
      expect(paints(value)[0].nativeCmykFillBlend).toBeUndefined(); expect(paints(value)[1].nativeCmykStrokeBlend).toBe('overprint-nonzero');
    });
    await payload(`/G0 gs ${square}`, { states: ['/OP true /OPM 1'] }, value => expect(paints(value)[0].nativeCmykFillBlend).toBe('overprint-nonzero'));
  });
  it.each(['.2 .4 .6 rg', '.5 g'])('requires actual DeviceCMYK source rather than converted zero inks: %s', color => expect(payload(`/G0 gs ${color} 0 0 20 20 re f`)).rejects.toMatchObject(unsupported));
  it.each(['B', 'B*', 'b', 'b*'])('keeps implicit combined fill-stroke groups unsupported: %s', kind => expect(payload(`/G0 gs 0 .7 0 .3 k 0 .7 0 .3 K 0 0 20 20 re ${kind}`)).rejects.toMatchObject(unsupported));
  it.each(['/AIS true /OP true', '/BM /Multiply /OP true'])('preserves the unsupported transparency guard: %s', state => expect(payload(`/G0 gs ${square}`, { states: [state] })).rejects.toMatchObject(unsupported));
  it.each(['-1', '2', '.5', '/Bad'])('rejects malformed OPM %s', mode => expect(payload(`/G0 gs ${square}`, { states: [`/OPM ${mode}`] })).rejects.toMatchObject({ code: 'pdf_corrupt' }));
});

describe('whole native overprint text-object contract', () => {
  const text = 'BT /F1 20 Tf 1 0 0 1 20 30 Tm (WW) Tj -10 0 Td (W) Tj ET';
  it('allows homogeneous opaque TKtrue overprint with eager uniform ink and no new text-group raster', () => payload(`/G0 gs 0 0 0 1 k ${text}`, {}, value => {
    expect(texts(value)).toHaveLength(2); expect(texts(value).every(c => c.nativeCmykBlend === 'overprint-nonzero' && c.alpha === 1)).toBe(true);
    expect(texts(value).map(c => c.glyphs.map(g => g.text).join('')).join('')).toBe('WWW');
  }));
  it('allows paint state to be established before the first glyph, matching ordinary PDF authoring', () => payload('BT /F1 20 Tf 0 0 0 1 k /G0 gs (WW) Tj ET', {}, value => expect(texts(value)[0].nativeCmykBlend).toBe('overprint-nonzero')));
  it('allows redundant effective-state reassertions without mistaking them for changed paint state', () => payload('/G0 gs 0 0 0 1 k BT /F1 20 Tf (W) Tj 0 0 0 1 k /G0 gs (W) Tj ET', {}, value => expect(texts(value)).toHaveLength(2)));
  it.each(['0 .7 0 .3 k (W) Tj 0 0 0 1 k (W) Tj', '0 .7 0 .3 k 0 0 0 1 k (W) Tj', '/G1 gs (W) Tj /G0 gs (W) Tj'])('rejects change-and-back across the entire object: %s', middle =>
    expect(payload(`/G0 gs 0 0 0 1 k BT /F1 20 Tf (W) Tj ${middle} ET`, { states: ['/OP true /OPM 1', '/OP false /OPM 0'] })).rejects.toMatchObject({ ...unsupported, message: expect.stringContaining('homogeneous opaque') }));
  it('does not apply the homogeneous shortcut to translucent TKtrue text', () => expect(payload(`/G0 gs 0 0 0 1 k ${text}`, { states: ['/OP true /OPM 1 /ca .5'] })).rejects.toMatchObject(unsupported));
  it('uses separate glyph compositing for explicit TKfalse, including different ink and opacity', () => payload('/G0 gs 0 0 0 1 k BT /F1 20 Tf (W) Tj 0 .7 0 .3 k (W) Tj ET', { states: ['/OP true /OPM 1 /ca .5 /TK false'] }, value => {
    expect(texts(value)).toHaveLength(2); expect(texts(value).every(c => c.alpha === .5 && c.nativeCmykBlend === 'overprint-nonzero')).toBe(true);
  }));
  it('rejects nontext painting inside the homogeneous text scope', () => expect(payload(`/G0 gs 0 0 0 1 k BT /F1 20 Tf (W) Tj ${square} ET`)).rejects.toMatchObject(unsupported));
  it.each(['true', 'false'])('rejects explicit TK changes within BT/ET even when set to %s', flag => expect(payload('BT /F1 20 Tf /G0 gs (W) Tj ET', { states: [`/TK ${flag}`] })).rejects.toMatchObject({ code: 'pdf_corrupt' }));
  it('rejects nonboolean TK outside the text object', () => expect(payload(`/G0 gs ${text}`, { states: ['/TK 1'] })).rejects.toMatchObject({ code: 'pdf_corrupt' }));
  it('cannot hide missing ET or unchecked heterogeneous glyphs with a restore from before BT', () =>
    expect(payload('q /G0 gs 0 0 0 1 k BT /F1 20 Tf (W) Tj 0 .7 0 .3 k (W) Tj Q')).rejects.toMatchObject({ code: 'pdf_corrupt' }));
  it('keeps a crossed q/BT/Q/ET object open until its actual ET', () => payload('0 0 0 1 k q BT /F1 20 Tf (W) Tj Q ET', {}, value => expect(texts(value)).toHaveLength(1)));
  it('does not allow a restored false framing flag to start a second nested BT', () => expect(payload('q BT /F1 20 Tf (W) Tj Q BT ET')).rejects.toMatchObject({ code: 'pdf_corrupt' }));
  it('preserves Tm and Tlm advances through q/Q within a text object', () => payload('0 0 0 1 k BT /F1 20 Tf 1 0 0 1 10 30 Tm (W) Tj q 3 4 Td (W) Tj Q (W) Tj T* (W) Tj ET', {}, value => {
    const t = texts(value); expect(t).toHaveLength(4);
    expect(t[1].matrix[4]).toBe(13); expect(t[1].matrix[5]).toBe(34);
    expect(t[2].matrix[4]).toBeGreaterThan(t[1].matrix[4]); expect(t[2].matrix[5]).toBe(34);
    expect(t[3].matrix[4]).toBe(13); expect(t[3].matrix[5]).toBe(34);
  }));
  it('rejects changing TK through a graphics restore within BT, not only through gs', () => expect(payload('q /G0 gs 0 0 0 1 k BT /F1 20 Tf (W) Tj Q (W) Tj ET', { states: ['/OP true /OPM 1 /TK false'] })).rejects.toMatchObject({ code: 'pdf_corrupt', message: expect.stringContaining('knockout') }));
  it.each([2, 6])('keeps combined text mode %s unsupported', mode => expect(payload(`/G0 gs 0 0 0 1 k BT /F1 20 Tf ${mode} Tr (W) Tj ET`)).rejects.toMatchObject(unsupported));
});
