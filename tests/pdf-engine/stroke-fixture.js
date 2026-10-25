import { simplePdf } from './fixtures.js';

export function strokeAdjustmentPdf() {
  const widths = [0, .1, .49, .51, 1, 1.49, 1.5, 2.6];
  const lines = widths.map((width, i) => `${width} w 20.2 ${20.2 + i * 14} m 220.2 ${20.2 + i * 14} l S`).join('\n');
  return simplePdf(`/G gs ${lines} q .8 .6 -.6 .8 240 180 cm .49 w [4 2] .25 d 0 0 m 120 0 l 120 50 l S Q q 1 0 0 1 20 220 cm 1.49 w 0 0 m 30 60 80 -20 140 40 c S Q`, {
    page: '/MediaBox [0 0 400 320] /Resources << /ExtGState << /G 6 0 R >> >>', extra: ['<< /SA true >>'],
  });
}
