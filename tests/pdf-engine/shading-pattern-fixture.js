import { pdf, stream } from './fixtures.js';

/** Original authored geometric pattern controls; no private corpus content. */
export function axialPatternPdf(content, { matrix = [64, 0, 0, 64, 16, 4], pattern = '', shading = '', page = '', form = null,
  formResources = '/Pattern << /P 5 0 R >>', graphicsState = '/ca .63 /CA .63 /BM /Multiply', functionBody = null, paintSpace = '/Pattern' } = {}) {
  return pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 96 72] >>',
    `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Pattern << /P 5 0 R >> /ColorSpace << /Paint ${paintSpace} >> /Font << /F1 8 0 R >> /ExtGState << /G 10 0 R >> ${form === null ? '' : '/XObject << /F 9 0 R >>'} >> ${page} >>`,
    stream(content), `<< /Type /Pattern /PatternType 2 /Matrix [${matrix.join(' ')}] /Shading 6 0 R ${pattern} >>`,
    `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 1 0] /Function 7 0 R /Extend [true true] ${shading} >>`,
    functionBody || '<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    form === null ? 'null' : stream(form, `/Type /XObject /Subtype /Form /BBox [0 0 32 20] /Resources << ${formResources} >>`),
    `<< /Type /ExtGState ${graphicsState} >>`]);
}

export const authoredPatternControls = [
  { name: 'fill-axis', content: '/Pattern cs /P scn 8 8 80 50 re f' },
  { name: 'stroke-axis', content: '/Pattern CS /P SCN 8 w 8 18 m 88 54 l S' },
  { name: 'stroke-rotate', content: '/Pattern CS /P SCN q .8660254 .5 -.5 .8660254 22 -8 cm 5 w 0 25 m 75 25 l S Q' },
  { name: 'stroke-shear', content: '/Pattern CS /P SCN q 1 .2 .35 .9 2 1 cm 4 w 8 12 m 68 46 l S Q' },
  { name: 'fill-cm-before', content: '1 0 .25 1 4 0 cm /Pattern cs /P scn 8 8 65 40 re f' },
  { name: 'fill-cm-after', content: '/Pattern cs /P scn 1 0 .25 1 4 0 cm 8 8 65 40 re f' },
  { name: 'evenodd', content: '/Paint cs /P scn 8 8 80 50 re 24 22 45 20 re f*' },
  { name: 'fill-stroke', content: '/Pattern cs /P scn 0 1 0 RG 3 w 8 8 80 50 re B' },
  { name: 'dash', content: '/Pattern CS /P SCN 5 w 1 J 2 j [5 3] 1.2 d 8 18 m 42 55 l 88 15 l S' },
  { name: 'hairline', content: '/Pattern CS /P SCN 0 w 8 18 m 88 54 l S' },
  { name: 'stroke-adjust', content: '/Pattern CS /P SCN /G gs 2.2 w 8.3 18.2 m 88.1 54.3 l S', options: { graphicsState: '/SA true' } },
  { name: 'alpha-multiply', content: '.7 .8 .6 rg 0 0 96 72 re f /G gs /Pattern cs /P scn 8 8 80 50 re f' },
  { name: 'clip', content: '12 14 60 35 re W n /Pattern cs /P scn 0 0 96 72 re f' },
  { name: 'forms-local', content: 'q 1 0 0 1 8 8 cm /F Do Q q 1 0 0 1 52 38 cm /F Do Q', options: { matrix: [32, 0, 0, 20, 0, 0], form: '/Pattern cs /P scn 0 0 32 20 re f' } },
  { name: 'forms-inherit', content: '/Pattern cs /P scn q 1 0 0 1 8 8 cm /F Do Q q 1 0 0 1 52 38 cm /F Do Q', options: { form: '0 0 32 20 re f' } },
  { name: 'construction-ctm', content: '/Pattern CS /P SCN q 1 .2 .3 1 2 0 cm 8 10 m Q 86 45 l 4 w S' },
];
