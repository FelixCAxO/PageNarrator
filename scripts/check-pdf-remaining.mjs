import { getPdfReadingProgress } from '../src/lib/pdf-reading-progress.js';

const [pageNumber, pageCount] = process.argv.slice(2).map(Number);
if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount
    || !Number.isInteger(pageCount) || pageCount < 1) {
  console.error('Usage: node scripts/check-pdf-remaining.mjs <current-page> <total-pages>');
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(getPdfReadingProgress({ pageNumber, pageCount }), null, 2));
}
