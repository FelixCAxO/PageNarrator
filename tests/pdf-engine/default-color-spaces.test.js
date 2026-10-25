// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { resolvePdfColorSpace } from '../../src/pdf/color-spaces.js';
import { simplePdf, stream, options, loadAsset } from './fixtures.js';

// Original definitions and expectations follow ISO32000-1 8.6.5.6.
const cases = [
  {"id": "identity-Gray-alias-False", "definitions": "/DefaultGray /DeviceGray", "selected": "DeviceGray", "expectedName": "DeviceGray", "expectedComponents": 1},
  {"id": "identity-Gray-alias-True", "definitions": "/DefaultGray /Alias /Alias /DeviceGray", "selected": "DeviceGray", "expectedName": "DeviceGray", "expectedComponents": 1},
  {"id": "explicit-default-name-Gray", "definitions": "/DefaultGray /DeviceGray", "selected": "DefaultGray", "expectedName": "DeviceGray", "expectedComponents": 1},
  {"id": "identity-RGB-alias-False", "definitions": "/DefaultRGB /DeviceRGB", "selected": "DeviceRGB", "expectedName": "DeviceRGB", "expectedComponents": 3},
  {"id": "identity-RGB-alias-True", "definitions": "/DefaultRGB /Alias /Alias /DeviceRGB", "selected": "DeviceRGB", "expectedName": "DeviceRGB", "expectedComponents": 3},
  {"id": "explicit-default-name-RGB", "definitions": "/DefaultRGB /DeviceRGB", "selected": "DefaultRGB", "expectedName": "DeviceRGB", "expectedComponents": 3},
  {"id": "identity-CMYK-alias-False", "definitions": "/DefaultCMYK /DeviceCMYK", "selected": "DeviceCMYK", "expectedName": "DeviceCMYK", "expectedComponents": 4},
  {"id": "identity-CMYK-alias-True", "definitions": "/DefaultCMYK /Alias /Alias /DeviceCMYK", "selected": "DeviceCMYK", "expectedName": "DeviceCMYK", "expectedComponents": 4},
  {"id": "explicit-default-name-CMYK", "definitions": "/DefaultCMYK /DeviceCMYK", "selected": "DefaultCMYK", "expectedName": "DeviceCMYK", "expectedComponents": 4},
  {"id": "indexed-base-identity", "definitions": "/DefaultRGB /DeviceRGB /Swatch [/Indexed /DeviceRGB 1 <001122AACCDD>]", "selected": "Swatch", "expectedName": "Indexed", "expectedBase": "DeviceRGB", "expectedComponents": 1, "input": [1], "rgb": [0.6666666666666666, 0.8, 0.8666666666666667]},
  {"id": "separation-alternate-identity", "definitions": "/DefaultRGB /DeviceRGB /Ink [/Separation /Spot /DeviceRGB << /FunctionType 2 /Domain [0 1] /C0 [1 1 1] /C1 [.2 .4 .6] /N 1 >>]", "selected": "Ink", "expectedName": "Separation", "expectedAlternate": "DeviceRGB", "expectedComponents": 1, "input": [0.5], "rgb": [0.6, 0.7, 0.8]},
  {"id": "default-separation-alternate-identity", "definitions": "/DefaultGray /Ink /DefaultRGB /DeviceRGB /Ink [/Separation /Spot /DeviceRGB << /FunctionType 2 /Domain [0 1] /C0 [1 1 1] /C1 [.2 .4 .6] /N 1 >>]", "selected": "DeviceGray", "expectedName": "Separation", "expectedAlternate": "DeviceRGB", "expectedComponents": 1, "input": [0.5], "rgb": [0.6, 0.7, 0.8]},
  {"id": "calibrated-gray-unchanged", "definitions": "/DefaultGray [/CalGray << /WhitePoint [.9642 1 .8249] /Gamma 2 >>]", "selected": "DeviceGray", "expectedName": "CalGray", "expectedComponents": 1, "input": [0.5], "xyz": [0.24105, 0.25, 0.206225]},
  {"id": "null-default-absent", "definitions": "/DefaultRGB null", "selected": "DeviceRGB", "expectedName": "DeviceRGB", "expectedComponents": 3},
  {"id": "default-devicen-same-family-alternate-once", "definitions": "/DefaultRGB [/DeviceN [/A /B /C] /DeviceRGB 6 0 R]", "selected": "DeviceRGB", "expectedName": "DeviceN", "expectedComponents": 3, "expectedAlternate": "DeviceRGB", "input": [0.25, 0.5, 0.75], "rgb": [0.25, 0.5, 0.75], "extra": [{"content": "{ }", "dictionary": "/FunctionType 4 /Domain [0 1 0 1 0 1] /Range [0 1 0 1 0 1]"}]},
  {"id": "different-family-default-in-alternate-still-applies", "definitions": "/DefaultRGB [/DeviceN [/A /B /C] /DeviceGray 6 0 R] /DefaultGray [/CalGray << /WhitePoint [.9642 1 .8249] /Gamma 2 >>]", "selected": "DeviceRGB", "expectedName": "DeviceN", "expectedComponents": 3, "expectedAlternate": "CalGray", "input": [0.2, 0.4, 0.6], "xyz": [0.154272, 0.16, 0.131984], "extra": [{"content": "{ add add 3 div }", "dictionary": "/FunctionType 4 /Domain [0 1 0 1 0 1] /Range [0 1]"}]},
  {"id": "fresh-top-call-keeps-calibrated-default", "definitions": "/DefaultRGB [/CalRGB << /WhitePoint [.9642 1 .8249] /Gamma [1 2 1] >>]", "selected": "DeviceRGB", "expectedName": "CalRGB", "expectedComponents": 3, "input": [0.2, 0.4, 0.6], "xyz": [0.2, 0.16, 0.6], "repeat": true},
];

const guards = [
  {"id": "gray-wrong-arity", "definitions": "/DefaultGray /DeviceRGB", "selected": "DeviceGray", "code": "pdf_corrupt"},
  {"id": "rgb-wrong-arity", "definitions": "/DefaultRGB /DeviceCMYK", "selected": "DeviceRGB", "code": "pdf_corrupt"},
  {"id": "cmyk-wrong-arity", "definitions": "/DefaultCMYK /DeviceRGB", "selected": "DeviceCMYK", "code": "pdf_corrupt"},
  {"id": "lab-default-forbidden", "definitions": "/DefaultRGB [/Lab << /WhitePoint [.9642 1 .8249] >>]", "selected": "DeviceRGB", "code": "pdf_corrupt"},
  {"id": "indexed-default-forbidden", "definitions": "/DefaultGray [/Indexed /DeviceRGB 0 <001122>]", "selected": "DeviceGray", "code": "pdf_corrupt"},
  {"id": "pattern-default-unsupported", "definitions": "/DefaultRGB /Pattern", "selected": "DeviceRGB", "code": "pdf_unsupported"},
  {"id": "named-resource-cycle", "definitions": "/DefaultRGB /Alias /Alias /Other /Other /Alias", "selected": "DeviceRGB", "code": "pdf_limit"},
  {"id": "cross-device-arity-not-bypassed", "definitions": "/DefaultGray /DeviceRGB /DefaultRGB /DeviceGray", "selected": "DeviceGray", "code": "pdf_corrupt"},
  {"id": "existing-depth-cap", "definitions": "/DefaultRGB /A /A /B /B /C /C /D /D /E /E /F /F /G /G /H /H /I /I /J /J /K /K /DeviceRGB", "selected": "DeviceRGB", "code": "pdf_limit"},
  {"id": "aliased-lab-default-forbidden", "definitions": "/DefaultRGB /L /L [/Lab << /WhitePoint [.9642 1 .8249] >>]", "selected": "DeviceRGB", "code": "pdf_corrupt"},
  {"id": "aliased-indexed-default-forbidden", "definitions": "/DefaultGray /L /L [/Indexed /DeviceRGB 0 <001122>]", "selected": "DeviceGray", "code": "pdf_corrupt"},
  {"id": "ordinary-alias-cycle", "definitions": "/Alias /Other /Other /Alias", "selected": "Alias", "code": "pdf_limit"},
];

async function withSpace(test, run) {
  const data = simplePdf('', { page: `/Resources << /ColorSpace << ${test.definitions} >> >>`, extra: (test.extra || []).map(item => stream(item.content, item.dictionary)) });
  const reader = await NativePdfReader.create(data, options);
  try {
    const page = reader.checked(reader.api.pn_pdf_resolve(3, 0)), resources = reader.field(page, 'Resources');
    const space = await resolvePdfColorSpace(reader, resources, test.selected, loadAsset);
    await run(space, reader);
    if (test.repeat) expect((await resolvePdfColorSpace(reader, resources, test.selected, loadAsset)).name).toBe(test.expectedName);
  } finally { reader.destroy(); }
}

describe('default PDF colour spaces apply once to the selected device space', () => {
  it.each(cases)('$id', async test => {
    await withSpace(test, async (space, reader) => {
      expect(space.name).toBe(test.expectedName); expect(space.components).toBe(test.expectedComponents);
      if (test.expectedBase) expect(space.base.name).toBe(test.expectedBase);
      if (test.expectedAlternate) expect(space.alternate.name).toBe(test.expectedAlternate);
      if (test.rgb) space.convert(test.input).forEach((value, index) => expect(value).toBeCloseTo(test.rgb[index], 6));
      else if (test.xyz) space.toXyz(test.input).forEach((value, index) => expect(value).toBeCloseTo(test.xyz[index], 6));
      else {
        const direct = await resolvePdfColorSpace(reader, 0, test.expectedName, loadAsset), values = Array.from({ length: space.components }, (_, index) => (index + 1) / (space.components + 1));
        expect(space.toXyz(values)).toEqual(direct.toXyz(values)); expect(space.convert(values)).toEqual(direct.convert(values));
      }
    });
  });
  it.each(guards)('preserves $code for $id', async test => {
    await expect(withSpace(test, () => {})).rejects.toMatchObject({ code: test.code });
  });
});
