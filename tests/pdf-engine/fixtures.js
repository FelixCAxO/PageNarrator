import { readFile } from 'node:fs/promises';
export const bytes = text => new Uint8Array(Buffer.from(text, 'latin1'));
export const wasm = await readFile(new URL('../../native/pdf.wasm', import.meta.url));
export const loadAsset = async name => new Uint8Array(await readFile(new URL(`../../vendor/pdf-data/${name}`, import.meta.url)));
export const options = { wasm, loadAsset, useWorker: false };
export function pdf(objects, trailer = '/Root 1 0 R') {
  let output = '%PDF-1.7\n'; const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(output, 'latin1')); output += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(output, 'latin1');
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return bytes(`${output}trailer\n<< /Size ${objects.length + 1} ${trailer} >>\nstartxref\n${xref}\n%%EOF\n`);
}
export function stream(content, dictionary = '') {
  const data = typeof content === 'string' ? content : Buffer.from(content).toString('latin1');
  return `<< /Length ${Buffer.byteLength(data, 'latin1')} ${dictionary} >>\nstream\n${data}\nendstream`;
}
export function simplePdf(content, { contents = stream(content), page = '', font = '/Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding', extra = [] } = {}) {
  return pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Type /Page /Parent 2 0 R /Contents 4 0 R ${page} >>`, contents, `<< ${font} >>`, ...extra]);
}
export const show = value => `BT /F1 12 Tf 1 0 0 1 54 700 Tm (${value}) Tj ET`;
export function nonIsolatedBlendPdf() {
  return simplePdf('.1 .7 .2 rg 0 0 300 400 re f q 2 0 0 2 30 100 cm /G gs /F Do Q', { page: '/Resources << /XObject << /F 6 0 R >> /ExtGState << /G 7 0 R /Inner 8 0 R >> >>', extra: [stream('/Inner gs 1 0 0 rg 0 0 50 50 re f 0 0 1 rg 25 25 50 50 re f', '/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Group << /S /Transparency /I false /CS /DeviceRGB >>'), '<< /Type /ExtGState /ca .5 >>', '<< /Type /ExtGState /ca .6 /BM /Multiply >>'] });
}
