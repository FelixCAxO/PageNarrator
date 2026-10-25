// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { parseIccProfile } from '../../src/pdf/icc-color.js';
import { convertPdfColor } from '../../src/pdf/icc-blend.js';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { syntheticRgbProfile } from './icc-fixture.js';
import { options, simplePdf, stream } from './fixtures.js';

describe('native colour in an identical ICC blending profile', () => {
  it('preserves exact components and half-byte ties through direct and resolved profile identity', () => {
    const profile = parseIccProfile(syntheticRgbProfile()), values = [.1, .8, .3];
    for (const source of [profile, { profile, toXyz: profile.toXyz }]) {
      const result = convertPdfColor(source, values, profile);
      expect(result).toEqual([.1, .8, .3]);
      expect(result.map(n => Math.round(n * 255))).toEqual([26, 204, 77]);
      expect(result).not.toBe(values);
    }
    expect(values).toEqual([.1, .8, .3]);
  });
  it('retains distinct encoded values on a monotone curve plateau', () => {
    const profile = parseIccProfile(syntheticRgbProfile({ curve: { samples: [0, 32768, 32768, 65535] } }));
    const values = [.4, .5, .6];
    expect(profile.fromXyz(profile.toXyz(values))).not.toEqual(values);
    expect(convertPdfColor(profile, values, profile)).toEqual(values);
  });
  it('clamps matching-profile input without mutating it', () => {
    const profile = parseIccProfile(syntheticRgbProfile()), values = [-.1, .2, 1.2];
    expect(convertPdfColor(profile, values, profile)).toEqual([0, .2, 1]);
    expect(values).toEqual([-.1, .2, 1.2]);
  });
  it.each([[.1, .2], [.1, NaN, .3], [.1, Infinity, .3]])('rejects malformed matching-profile components %j', values => {
    const profile = parseIccProfile(syntheticRgbProfile());
    expect(() => convertPdfColor(profile, values, profile)).toThrow(/components/);
  });
  it('continues converting different profiles through PCS', () => {
    const source = parseIccProfile(syntheticRgbProfile()), target = parseIccProfile(syntheticRgbProfile({ curve: { gamma: 1 } }));
    const result = convertPdfColor({ profile: source, toXyz: source.toXyz }, [.1, .8, .3], target);
    [.01, .64, .09].forEach((n, i) => expect(result[i]).toBeCloseTo(n, 12));
  });
  it('does not use identity to admit unsupported four-channel or noninvertible targets', () => {
    const four = { channels: 4, fromXyz: n => n };
    const forwardOnly = parseIccProfile(syntheticRgbProfile({ curve: { samples: [0, 40000, 10000, 65535] } }));
    expect(() => convertPdfColor(four, [0, 0, 0, 0], four)).toThrow(/inverse/);
    expect(() => convertPdfColor(forwardOnly, [.1, .2, .3], forwardOnly)).toThrow(/inverse/);
  });
  it.each([
    ['/C cs .1 .8 .3 sc', '/C [/ICCBased 6 0 R]'],
    ['/C cs .1 .8 .3 sc', '/C /Alias /Alias [/ICCBased 7 0 R]'],
    ['.1 .8 .3 rg', '/DefaultRGB [/ICCBased 7 0 R]'],
  ])('preserves native paint values through page-local profile canonicalization: %s', async (paint, colorSpaces) => {
    const bytes = simplePdf(`${paint} 0 0 50 50 re f`, {
      page: `/Group << /S /Transparency /CS [/ICCBased 6 0 R] >> /Resources << /ColorSpace << ${colorSpaces} >> >>`,
      extra: [stream(syntheticRgbProfile(), '/N 3'), stream(syntheticRgbProfile(), '/N 3')],
    });
    const core = await createPdfDocumentCore(bytes, options);
    try {
      const payload = await core.pagePayload(1), group = payload.commands[0];
      expect(group.op).toBe('group');
      expect(group.commands.filter(c => c.op === 'color' && c.fill).at(-1).value).toBe('rgb(26,204,77)');
      const again = await core.pagePayload(1);
      expect(again.items).toEqual(payload.items);
    } finally { core.destroy(); }
  });
});
