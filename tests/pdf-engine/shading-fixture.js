import { simplePdf, stream } from './fixtures.js';

export function axialShadingPdf({ explicitClip = false } = {}) {
  return simplePdf(`.85 g 0 0 400 320 re f /Sample sh /Power sh /Stitch sh q 1.2 .2 .3 .8 210 0 cm ${explicitClip ? '0 20 100 260 re W n ' : ''}/Channels sh Q`, {
    page: '/MediaBox [0 0 400 320] /Resources << /Shading << /Sample 6 0 R /Power 8 0 R /Stitch 10 0 R /Channels 12 0 R >> >>',
    extra: [
      '<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [40 0 160 0] /Domain [2 4] /BBox [20 20 180 80] /Function 7 0 R >>',
      stream(Uint8Array.of(0, 0, 255, 0, 255, 0, 255, 0, 0), '/FunctionType 0 /Domain [2 4] /Range [0 1 0 1 0 1] /Size [3] /BitsPerSample 8'),
      '<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [40 0 160 0] /BBox [20 100 180 160] /Extend [true false] /Function 9 0 R >>',
      '<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 2 >>',
      '<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [40 0 160 0] /BBox [20 180 180 240] /Extend [false true] /Function 11 0 R >>',
      '<< /FunctionType 3 /Domain [0 1] /Functions [<< /FunctionType 2 /Domain [0 1] /C0 [0 1 0] /C1 [1 1 0] /N 1 >> << /FunctionType 2 /Domain [0 1] /C0 [0 0 1] /C1 [0 1 0] /N 1 >>] /Bounds [.4] /Encode [0 1 1 0] >>',
      `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 20 100 280] ${explicitClip ? '' : '/BBox [0 20 100 280] '}/Extend [true true] /Function [<< /FunctionType 2 /Domain [0 1] /N 1 >> << /FunctionType 2 /Domain [0 1] /C0 [1] /C1 [0] /N 1 >> << /FunctionType 2 /Domain [0 1] /C0 [.25] /C1 [.25] /N 1 >>] >>`,
    ],
  });
}
