import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { resolvePdfColorSpace } from '../../src/pdf/color-spaces.js';
import { pdfPayloadBuffers } from '../../src/pdf/payload-buffers.js';
import { syntheticRgbProfile } from './icc-fixture.js';
import { options, pdf, stream } from './fixtures.js';

const profile = syntheticRgbProfile();
function fixture({ second = profile, metadata = '/N 3', twoPages = false } = {}) {
  const page = '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Group << /S /Transparency /CS /A >> /Resources << /ColorSpace << /A [/ICCBased 7 0 R] /B [/ICCBased 8 0 R] >> /XObject << /F 5 0 R /I 9 0 R >> /ExtGState << /Half 11 0 R >> >> >>';
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [3 0 R ${twoPages ? '10 0 R' : ''}] /Count ${twoPages ? 2 : 1} /MediaBox [0 0 10 10] >>`,
    page, stream('/I Do /Half gs /F Do'), stream('/I Do', '/Subtype /Form /BBox [0 0 10 10] /Group << /S /Transparency /CS /B >>'), 'null',
    stream(profile, '/N 3'), stream(second, metadata),
    stream(Uint8Array.of(55, 120, 210), '/Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceRGB'), page, '<< /ca .5 >>',
  ]);
}
async function withSpaces(bytes, run) {
  const reader = await NativePdfReader.create(bytes, options);
  try {
    const page = reader.checked(reader.api.pn_pdf_resolve(3, 0)), resources = reader.field(page, 'Resources'), memo = new Map();
    const resolve = (name, cache = memo) => resolvePdfColorSpace(reader, resources, name, options.loadAsset, 0, cache);
    await run({ reader, memo, resolve });
  } finally { reader.destroy(); }
}

describe('build-local exact-byte ICC canonicalization', () => {
  it('shares only the canonical owned profile after validating two different source streams', async () => {
    await withSpaces(fixture(), async ({ reader, memo, resolve }) => {
      const firstId = reader.checked(reader.api.pn_pdf_resolve(7, 0)), secondId = reader.checked(reader.api.pn_pdf_resolve(8, 0));
      const read = reader.bytes.bind(reader), reads = [];
      reader.bytes = value => { const id = (typeof value === 'number' ? reader.node(value) : value).id; if ([firstId, secondId].includes(id)) reads.push(id); return read(value); };
      const first = await resolve('A'), second = await resolve('B');
      expect(firstId).not.toBe(secondId); expect(reads).toEqual([firstId, secondId]); expect(memo.size).toBe(2);
      expect(second).toBe(first); expect(second.profileBytes).toBe(first.profileBytes); expect(second.profile).toBe(first.profile);
      expect(second.profileIdentity).toBe(first.profileIdentity);
      const charges = [...memo.values()].map(entry => [entry.decodedBytes, entry.comparisonBytes]);
      expect(await resolve('B')).toBe(first); expect(reads).toHaveLength(2);
      expect([...memo.values()].map(entry => [entry.decodedBytes, entry.comparisonBytes])).toEqual(charges);
    });
  });

  it('keeps general resolution without a build memo independent', async () => {
    await withSpaces(fixture(), async ({ memo, resolve }) => {
      const first = await resolve('A', null), second = await resolve('B', null);
      expect(second.profileBytes).toEqual(first.profileBytes); expect(second.profileBytes).not.toBe(first.profileBytes);
      expect(second.profileIdentity).not.toBe(first.profileIdentity); expect(memo.size).toBe(0);
    });
  });

  it('keeps byte-different profiles separate even when their numerical transforms match', async () => {
    const different = profile.slice(); different[85] ^= 1; // Unused profile-ID byte; colour tags are unchanged.
    await withSpaces(fixture({ second: different }), async ({ resolve }) => {
      const first = await resolve('A'), second = await resolve('B');
      expect(second.profileBytes).not.toEqual(first.profileBytes); expect(second.profileIdentity).not.toBe(first.profileIdentity);
      expect(second.profile).not.toBe(first.profile); expect(second.convert([.2, .4, .6])).toEqual(first.convert([.2, .4, .6]));
    });
  });

  it.each([
    ['/N 4', 'pdf_corrupt', /component counts disagree/],
    ['/N null', 'pdf_corrupt', /component counts disagree/],
    ['/N 3 /Range [0 1 0 1]', 'pdf_corrupt', /Invalid ICC input range/],
    ['/N 3 /Range [0 .8 0 1 0 1]', 'pdf_unsupported', /Non-default PDF ICC input ranges/],
  ])('validates independent stream metadata before reusing equal bytes: %s', async (metadata, code, message) => {
    await withSpaces(fixture({ metadata }), async ({ memo, resolve }) => {
      await resolve('A'); await expect(resolve('B')).rejects.toMatchObject({ code, message }); expect(memo.size).toBe(1);
    });
  });

  it.each(['/N 3 /Range null', '/N 3 /Range [0 1 0 1 0 1]'])('accepts equivalent validated metadata: %s', async metadata => {
    await withSpaces(fixture({ metadata }), async ({ resolve }) => expect(await resolve('B')).toBe(await resolve('A')));
  });

  it('deduplicates transfer buffers and rebuilds fresh profiles after detach, another page and cleanup', async () => {
    const core = await createPdfDocumentCore(fixture({ twoPages: true }), options);
    try {
      const first = await core.pagePayload(1), page = first.commands[0], nested = page.commands.find(c => c.op === 'group');
      expect(nested.colorProfile).toBe(page.colorProfile);
      const images = page.commands.flatMap(c => c.op === 'image' ? [c] : c.commands?.filter(child => child.op === 'image') || []);
      expect(images).toHaveLength(2); expect(images[0].pixels).toBe(images[1].pixels);
      expect(pdfPayloadBuffers(first).filter(buffer => buffer === page.colorProfile.buffer)).toHaveLength(1);
      const clone = structuredClone(first, { transfer: pdfPayloadBuffers(first) }); expect(page.colorProfile.byteLength).toBe(0);
      expect(clone.commands[0].commands.find(c => c.op === 'group').colorProfile).toBe(clone.commands[0].colorProfile);
      const second = await core.pagePayload(2); expect(second.commands[0].colorProfile).toEqual(profile);
      expect(second.commands[0].colorProfile).not.toBe(clone.commands[0].colorProfile);
      core.cleanup(1); const rebuilt = await core.pagePayload(1); expect(rebuilt.commands[0].colorProfile).toEqual(profile);
      expect(rebuilt.commands[0].commands.find(c => c.op === 'group').colorProfile).toBe(rebuilt.commands[0].colorProfile);
    } finally { core.destroy(); }
  });
});

function paddedProfile(length, value = 0) {
  const bytes = new Uint8Array(length); bytes.set(profile); new DataView(bytes.buffer).setUint32(0, bytes.length); bytes[bytes.length - 1] = value; return bytes;
}
function budgetFixture(profiles) {
  const resources = profiles.map((_, index) => `/P${index} [/ICCBased ${index + 5} 0 R]`).join(' ');
  return pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /Resources << /ColorSpace << ${resources} >> >> >>`, 'null',
    ...profiles.map(bytes => stream(deflateSync(bytes), '/N 3 /Filter /FlateDecode'))]);
}

describe('exact-byte canonicalization resource admission', () => {
  it('charges byte-equal source identities at the32MiB decoded-byte boundary', async () => {
    const padded = paddedProfile(16 * 1024 * 1024);
    await withSpaces(budgetFixture([padded, padded, profile]), async ({ memo, resolve }) => {
      expect(await resolve('P1')).toBe(await resolve('P0')); expect(memo.size).toBe(2);
      await expect(resolve('P2')).rejects.toMatchObject({ code: 'pdf_limit', message: 'PDF page blend profile budget exceeded.' });
    });
  });

  it('bounds cumulative exact comparison work independently of decoded-byte admission', async () => {
    const profiles = Array.from({ length: 9 }, (_, index) => paddedProfile(1024 * 1024, index));
    await withSpaces(budgetFixture(profiles), async ({ memo, resolve }) => {
      for (let index = 0; index < 8; index++) await resolve('P' + index); // 28MiB compared;8MiB admitted.
      expect(memo.size).toBe(8);
      const charges = [...memo.values()].map(entry => [entry.decodedBytes, entry.comparisonBytes]);
      await expect(resolve('P8')).rejects.toMatchObject({ code: 'pdf_limit', message: 'PDF page blend profile budget exceeded.' });
      expect(memo.size).toBe(8);
      expect([...memo.values()].map(entry => [entry.decodedBytes, entry.comparisonBytes])).toEqual(charges);
    });
  });
});
