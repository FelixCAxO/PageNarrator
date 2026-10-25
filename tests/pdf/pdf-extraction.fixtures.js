export function tinyPdfBytes() {
  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length 95 >>
stream
BT
/F1 24 Tf
72 720 Td
(Hello PDF from browser) Tj
0 -36 Td
(Second line text) Tj
ET
endstream
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000241 00000 n 
0000000311 00000 n 
trailer
<< /Root 1 0 R /Size 6 >>
startxref
456
%%EOF`;
  return new TextEncoder().encode(pdf);
}

export function createFakePdfDocument(pages) {
  const cleanupCalls = [];
  const document = {
    numPages: pages.length,
    destroyed: false,
    cleanupCalls,
    async getPage(pageNumber) {
      const page = pages[pageNumber - 1] || '';
      const items = Array.isArray(page) ? page : textToItems(page);
      return {
        view: [0, 0, 612, 792],
        async getTextContent() {
          return {
            items,
          };
        },
        cleanup() {
          cleanupCalls.push(pageNumber);
        },
      };
    },
    async destroy() {
      document.destroyed = true;
    },
  };
  return document;
}

export function textToItems(text) {
  return String(text || '').split(/\s+/).filter(Boolean).map((word, index) => textItem(word, 72 + index * 30, 720));
}

export function textItem(str, x, y, options = {}) {
  const height = options.height ?? 12;
  return {
    str,
    transform: options.transform || [height, 0, 0, height, x, y],
    height,
    width: options.width ?? String(str).length * Math.max(6, height * 0.55),
  };
}
