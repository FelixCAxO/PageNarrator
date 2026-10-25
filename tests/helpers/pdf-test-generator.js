/**
 * Pure JavaScript PDF 1.4 binary generator for creating real, valid PDF files
 * in memory for unit and integration testing with PDF.js.
 */

function escapePdfText(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

const WIN_ANSI_MAP = {
  '\u2018': 0x91, '\u2019': 0x92, '\u201C': 0x93, '\u201D': 0x94,
  '\u2022': 0x95, '\u2013': 0x96, '\u2014': 0x97, '\u0152': 0x8C,
  '\u0153': 0x9C, '\u0178': 0x9F, '\u20AC': 0x80,
};

export function encodeWinAnsiString(str) {
  const bytes = [];
  const text = String(str || '');
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0xFF) {
      bytes.push(code);
    } else if (WIN_ANSI_MAP[text[i]]) {
      bytes.push(WIN_ANSI_MAP[text[i]]);
    } else {
      bytes.push(0x3F);
    }
  }
  return Buffer.from(bytes).toString('latin1');
}

/**
 * Builds a valid PDF 1.4 binary (Uint8Array) from structured page descriptors.
 *
 * @param {Array<Object>|Object} pages - Array of page objects { items: [...], width, height } or flat items array
 * @param {Object} [options]
 * @param {number} [options.width=612] - Default page width in points (Letter width)
 * @param {number} [options.height=792] - Default page height in points (Letter height)
 * @param {boolean} [options.isImageOnly=false] - Generate a 1x1 raster image page without text (scanned PDF)
 * @returns {Uint8Array} Valid binary PDF data
 */
export function buildPdfBytes(pages, {
  width: defaultWidth = 612,
  height: defaultHeight = 792,
  isImageOnly = false,
} = {}) {
  const pageList = Array.isArray(pages)
    ? (pages.length > 0 && Array.isArray(pages[0]?.items) ? pages : [{ items: pages }])
    : [{ items: [] }];

  let pdf = '%PDF-1.4\n';
  const offsets = [];

  function addObj(content) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    const objNum = offsets.length;
    pdf += `${objNum} 0 obj\n${content}\nendobj\n`;
    return objNum;
  }

  const totalPages = pageList.length;
  const kids = [];
  for (let i = 0; i < totalPages; i += 1) {
    kids.push(`${3 + i * 2} 0 R`);
  }

  // Obj 1: Catalog
  addObj('<< /Type /Catalog /Pages 2 0 R >>');
  // Obj 2: Pages tree
  addObj(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${totalPages} >>`);

  const fontObjIndex = 3 + totalPages * 2;
  const imageObjIndex = isImageOnly ? fontObjIndex + 1 : 0;

  for (let i = 0; i < totalPages; i += 1) {
    const pageData = pageList[i] || {};
    const pageWidth = pageData.width || defaultWidth;
    const pageHeight = pageData.height || defaultHeight;
    const items = pageData.items || [];

    const streamLines = ['BT'];
    for (const item of items) {
      const fontSize = item.fontSize || item.height || 12;
      const x = Number.isFinite(item.x) ? item.x : 54;
      const y = Number.isFinite(item.y) ? item.y : 700;
      const text = item.text || item.str || '';
      const encoded = encodeWinAnsiString(text);
      const transform = item.transform || [1, 0, 0, 1, x, y];
      streamLines.push(`/F1 ${fontSize} Tf ${transform.join(' ')} Tm (${escapePdfText(encoded)}) Tj`);
    }
    streamLines.push('ET');

    if (isImageOnly) {
      streamLines.push(`q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Im1 Do Q`);
    }

    const streamContent = streamLines.join('\n');
    const streamLen = Buffer.byteLength(streamContent, 'latin1');

    const contentObjIndex = 3 + i * 2 + 1;
    const resources = isImageOnly
      ? `<< /Font << /F1 ${fontObjIndex} 0 R >> /XObject << /Im1 ${imageObjIndex} 0 R >> >>`
      : `<< /Font << /F1 ${fontObjIndex} 0 R >> >>`;

    const rotation = pageData.rotation ? ` /Rotate ${pageData.rotation}` : '';
    addObj(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}]${rotation} /Resources ${resources} /Contents ${contentObjIndex} 0 R >>`);
    addObj(`<< /Length ${streamLen} >>\nstream\n${streamContent}\nendstream`);
  }

  // Font object
  addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  // If image-only (scanned simulation), add 1x1 black pixel Image XObject
  if (isImageOnly) {
    const rawPixel = Buffer.from([0, 0, 0]);
    addObj(`<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\n${rawPixel.toString('latin1')}\nendstream`);
  }

  const startXref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${offsets.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${startXref}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}
