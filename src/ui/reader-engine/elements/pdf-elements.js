export function getReaderEnginePdfElements(documentRef = globalThis.document) {
  const byId = (id) => documentRef.getElementById(id);
  return {
    pdfPageNav: byId('pdf-page-nav'),
    pdfPageFirst: byId('pdf-page-first-btn'),
    pdfPageJumpInput: byId('pdf-page-jump-input'),
    pdfPageJump: byId('pdf-page-jump-btn'),
    pdfPageSkip: byId('pdf-page-skip-btn'),
  };
}
