// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { singleImageGroupPdf } from './single-image-group-fixture.js';
import { options } from './fixtures.js';

async function payload(changes) {
  const core = await createPdfDocumentCore(singleImageGroupPdf(changes), options);
  try { return await core.pagePayload(1); } finally { core.destroy(); }
}
function images(commands) { return commands.flatMap(c => c.commands ? images(c.commands) : ['image', 'jpeg'].includes(c.op) ? [c] : []); }
describe('one opaque image in a nonisolated Normal group', () => {
  it.each(['Multiply', 'Screen', 'Darken', 'Difference', 'Hue'])('applies the supported outer %s blend once while retaining clipping and geometry', async blend => {
    const grouped = await payload({ blend }), flat = await payload({ blend, flat: true });
    const [image] = images(grouped.commands), [reference] = images(flat.commands);
    expect(image.blend).toBe(reference.blend);
    expect(image.alpha).toBe(1); expect(image.matrix).toEqual(reference.matrix);
    expect(image.pixels).toEqual(reference.pixels);
    expect(grouped.commands.filter(c => c.op === 'paint')).toEqual(flat.commands.filter(c => c.op === 'paint'));
    expect(grouped.items).toEqual([]); expect(grouped.inspection.hasRasterImage).toBe(true);
  });
  it('retains the same-profile ICC parent and source conversion', async () => {
    const grouped = await payload({ icc: true }), flat = await payload({ icc: true, flat: true });
    expect(grouped.commands[0].op).toBe('group');
    expect(images(grouped.commands)[0]).toEqual(images(flat.commands)[0]);
  });
  it('retains opaque JPEG transport while applying the outer blend', async () => {
    const grouped = await payload({ jpeg: true }), flat = await payload({ jpeg: true, flat: true });
    const image = images(grouped.commands)[0];
    expect(image.op).toBe('jpeg'); expect(image.blend).toBe('multiply');
    expect(image).toEqual(images(flat.commands)[0]);
  });
  it('refuses JPEG colour-key transparency before group collapse', async () => {
    await expect(payload({ jpeg: true, transparent: true })).rejects.toMatchObject({ code: 'pdf_unsupported', message: expect.stringMatching(/outer blend/) });
  });
  it.each([
    { outerAlpha: .5 }, { innerAlpha: .5 }, { innerBlend: 'Multiply' }, { transparent: true },
    { body: '1 0 0 rg 20 20 10 10 re f 50 0 0 50 30 30 cm /I Do' },
    { body: 'q 50 0 0 50 30 30 cm /I Do Q q 50 0 0 50 70 70 cm /I Do Q' },
    { body: '0 0 40 40 re f' },
  ])('keeps the general group-blend guard for %j', async changes => {
    await expect(payload(changes)).rejects.toMatchObject({ code: 'pdf_unsupported', message: expect.stringMatching(/outer blend/) });
  });
  it('leaves already supported isolated image groups as groups', async () => {
    const result = await payload({ isolated: true });
    expect(result.commands[0].commands.some(c => c.op === 'group' && c.blend === 'multiply')).toBe(true);
  });
});
