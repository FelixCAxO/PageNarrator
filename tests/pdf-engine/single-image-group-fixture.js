// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { simplePdf, stream } from './fixtures.js';
import { syntheticRgbProfile } from './icc-fixture.js';

export function singleImageGroupPdf({ blend = 'Multiply', flat = false, icc = false, body = null, outerAlpha = 1, innerAlpha = 1, innerBlend = 'Normal', transparent = false, isolated = false, jpeg = false } = {}) {
  const groupSpace = icc ? '[/ICCBased 9 0 R]' : '/DeviceRGB';
  // Header-only JPEG exercises existing transport, not browser decoding.
  const image = jpeg ? Uint8Array.of(255, 216, 255, 192, 0, 17, 8, 0, 2, 0, 2, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 255, 217)
    : Uint8Array.of(192, 41, 73, 23, 208, 137, 38, 60, 221, 242, 190, 27);
  const program = body ?? `q /Inner gs 53.5 8 5 39.5 35.25 28.75 cm ${flat ? '/Outer gs ' : ''}/I Do Q`;
  return simplePdf('.2 .7 .5 rg 0 0 240 180 re f q 1 .1 .2 1 11 4 cm /Outer gs /F Do Q', {
    page: `/MediaBox [0 0 240 180] /Group << /S /Transparency /CS ${groupSpace} >> /Resources << /XObject << /F 6 0 R >> /ExtGState << /Outer 8 0 R >> >>`,
    extra: [
      stream(program, `/Type /XObject /Subtype /Form /BBox [25 15 110 100] ${flat ? '' : `/Group << /S /Transparency /I ${isolated} /K false /CS ${groupSpace} >>`} /Resources << /XObject << /I 7 0 R >> /ExtGState << /Inner 10 0 R /Outer 8 0 R >> >>`),
      stream(image, `/Subtype /Image /Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB ${jpeg ? '/Filter /DCTDecode' : ''} ${transparent ? '/Mask [192 192 41 41 73 73]' : ''}`),
      `<< /Type /ExtGState /BM /${blend} /ca ${outerAlpha} /CA ${outerAlpha} /AIS true /SMask /None >>`,
      stream(syntheticRgbProfile(), '/N 3'),
      `<< /Type /ExtGState /BM /${innerBlend} /ca ${innerAlpha} /CA ${innerAlpha} /SMask /None >>`,
    ],
  });
}
