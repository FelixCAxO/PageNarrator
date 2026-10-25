import { simplePdf, show } from './fixtures.js';

// Intentionally sideways after intrinsic rotation; native selection survives, while narration excludes it.
export const croppedRotatedSidewaysPdf = () => simplePdf(show('Cropped rotated source remains selectable.'), { page: '/CropBox [30 600 400 760] /Rotate 90' });
// Counter-rotated source text is upright after /Rotate and entirely inside the same nonzero crop.
export const croppedRotatedUprightPdf = () => simplePdf('BT /F1 12 Tf 0 1 -1 0 300 630 Tm (Upright cropped source.) Tj ET', { page: '/CropBox [30 600 400 760] /Rotate 90' });
