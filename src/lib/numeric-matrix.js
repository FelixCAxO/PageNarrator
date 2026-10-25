// Numeric matrices use repeated symbolic row IDs; ordinary labels, units and prose stay readable.
export function numericMatrixLabel(text) {
  return String(text || '').normalize('NFKC').replace(/\s|_/gu, '').match(/^([\p{L}]{1,2})\d{1,3}$/u)?.[1]?.toLowerCase() || '';
}

export function isNumericMatrixValue(text) {
  return /^[+−-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)%?$/u.test(String(text || '').trim());
}

export function isNumericMatrix(rows) {
  if (rows.length < 3) return false;
  const label = numericMatrixLabel(rows[0][0]);
  return Boolean(label) && new Set(rows.map((row) => String(row[0]).normalize('NFKC').replace(/\s|_/gu, '').toLowerCase())).size >= 3
    && rows.every((row) => numericMatrixLabel(row[0]) === label
      && row.slice(1).some(isNumericMatrixValue)
      && row.slice(1).every((cell) => !cell || isNumericMatrixValue(cell)));
}
