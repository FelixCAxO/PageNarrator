import { pdf, stream } from './fixtures.js';

const ordinary = [8.2, 0, 0, 6.2, 9.125, 5.375];
export const tilingControls = [
  { name: 'phase-quadrants', kind: 'quadrants' },
  { name: 'negative-phase', kind: 'quadrants', matrix: [8.2, 0, 0, 6.2, -9.125, -5.375] },
  { name: 'reflection', kind: 'quadrants', matrix: [-8.2, 0, 0, 6.2, 9.125, 5.375] },
  { name: 'right-angle', kind: 'quadrants', matrix: [0, 8.2, -6.2, 0, 9.125, 5.375] },
  { name: 'negative-steps', kind: 'quadrants', steps: [-1, -1] },
  { name: 'transparent-gap', kind: 'green', bbox: [.25, .25, .75, .75] },
  { name: 'offset-wrap-gap', kind: 'green', bbox: [.75, 0, 1.25, 1] },
  { name: 'solid-gap-zero', kind: 'solid' },
  { name: 'solid-offset-wrap', kind: 'solid', bbox: [.2, -.3, 1.2, .7] },
  { name: 'solid-offset-reflected', kind: 'solid', bbox: [.2, -.3, 1.2, .7], matrix: [-8.2, 0, 0, 6.2, 9.125, 5.375] },
  { name: 'original-stencil-checker', kind: 'stencil' },
  { name: 'original-indexed-image', kind: 'indexed' },
  { name: 'normal-intrinsic-alpha', kind: 'solid', alpha: .5 },
  { name: 'displacement-exact-one', kind: 'solid', bbox: [1, 0, 2, 1], matrix: [7.75, 0, 0, 6, 9.125, 5.375] },
  { name: 'displacement-over-one', kind: 'solid', bbox: [1.0001, 0, 2.0001, 1], matrix: [7.75, 0, 0, 6, 9.125, 5.375], reject: 'distortion' },
  { name: 'rounded-zero-period', kind: 'solid', matrix: [.2, 0, 0, 6, 9.125, 5.375], reject: 'period' },
  { name: 'oblique-basis', kind: 'solid', matrix: [8, 1, 0, 6, 9.125, 5.375], reject: 'basis' },
];
export const complete = control => ({ matrix: ordinary, bbox: [0, 0, 1, 1], steps: [1, 1], alpha: 1, ...control });

export function tilingPdf(input) {
  const c = complete(input), [x, y, right, top] = c.bbox, rectangle = `${x} ${y} ${right - x} ${top - y} re f`;
  let content = c.kind === 'green' ? `0 1 0 rg ${rectangle}` : `0 0 1 rg ${rectangle}`;
  if (c.kind === 'quadrants') content = '1 0 0 rg 0 0 .5 .5 re f 0 1 0 rg .5 0 .5 .5 re f 0 0 1 rg 0 .5 .5 .5 re f 1 1 0 rg .5 .5 .5 .5 re f';
  if (c.kind === 'stencil') content = '1 g 0 0 1 1 re f 0 g BI /W 2 /H 2 /BPC 1 /IM true /D [1 0] ID \x80\x40 EI';
  if (c.kind === 'indexed') content = '/X Do';
  if (c.alpha !== 1) content = '/G gs ' + content;
  return pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 96 72] >>',
    `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Pattern << /P 5 0 R >> ${c.pageResources ? c.pageResources + ' ' : ''}>> >>`, stream(c.pageContent ?? '/Pattern cs /P scn 0 0 96 72 re f'),
    stream(c.cellContent ?? content, `/Type /Pattern /PatternType 1 /PaintType ${c.paintType ?? 1} /TilingType ${c.tilingType ?? 1} /BBox [${c.bbox.join(' ')}] /XStep ${c.steps[0]} /YStep ${c.steps[1]} /Matrix [${c.matrix.join(' ')}] /Resources ${c.cellResources ?? '<< /XObject << /X 6 0 R >> /ExtGState << /G 7 0 R >> >>'}`),
    c.imageObject ?? stream(Uint8Array.of(0, 1, 2, 3), '/Type /XObject /Subtype /Image /Width 2 /Height 2 /BitsPerComponent 8 /Interpolate false /ColorSpace [/Indexed /DeviceRGB 3 <ff000000ff000000ffffffff>]'),
    `<< /Type /ExtGState /ca ${c.alpha} /CA ${c.alpha} /BM /${c.blend || 'Normal'}${c.gsFields ? ' ' + c.gsFields : ''} >>`, ...(c.extra || [])]);
}

