// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { simplePdf } from './fixtures.js';

/** Original valid direct-shading controls; no operator changes occur inside an unfinished path. */
export function radialShadingPdf() {
  const circles = [[50, 50, 10, 50, 50, 40], [50, 50, 40, 50, 50, 10],
    [20, 35, 10, 75, 55, 22], [20, 50, 18, 80, 50, 18], [15, 50, 0, 70, 50, 55], [20, 20, 3, 60, 50, 35]];
  const locations = [[20, 20], [145, 20], [270, 20], [20, 155], [145, 155], [270, 155]];
  const functionValue = '<< /FunctionType 2 /Domain [0 1] /C0 [0 0 1] /C1 [1 0 0] /N 1 >>';
  const extras = circles.map((coords, index) => `<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [${coords.join(' ')}] /BBox [0 0 100 100] /Function ${functionValue} /Extend [${index === 1 ? 'true true' : index === 4 ? 'false true' : 'false false'}] >>`);
  const commands = locations.map(([x, y], index) => `q 1 0 0 1 ${x} ${y} cm 0 0 100 100 re W n ${index === 5 ? '.8 .15 -.1 .85 15 0 cm ' : ''}/R${index} sh Q`).join(' ');
  return simplePdf(commands + ' BT /F1 12 Tf 1 0 0 1 20 290 Tm (Original radial shading) Tj ET', {
    page: `/MediaBox [0 0 400 320] /Resources << /Font << /F1 5 0 R >> /Shading << ${extras.map((_, index) => `/R${index} ${index + 6} 0 R`).join(' ')} >> >>`, extra: extras,
  });
}
