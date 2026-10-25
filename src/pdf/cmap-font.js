// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';

export function chargeCidMetricWork(budget, count) {
  if ((budget.used += count) > 500000) throw new PdfEngineError('CID metric mapping work limit exceeded.', 'pdf_limit');
}

/** ISO 32000 CIDFont W2/DW2 triples, in the font's 1000-unit coordinate space. */
export function readCidVerticalMetrics(reader, descendant, width, budget = { used: 0 }) {
  const defaultId = reader.field(descendant, 'DW2'), defaults = defaultId ? reader.array(defaultId).map(id => reader.number(id, NaN)) : [880, -1000];
  if (defaults.length !== 2 || defaults.some(value => !Number.isFinite(value))) throw new PdfEngineError('Invalid CID default vertical metrics.', 'pdf_corrupt');
  const valuesId = reader.field(descendant, 'W2'), values = valuesId ? reader.array(valuesId) : [], metrics = new Map();
  const triple = values => {
    const data = values.map(id => reader.number(id, NaN));
    if (data.length !== 3 || data.some(value => !Number.isFinite(value))) throw new PdfEngineError('Invalid CID vertical metric triple.', 'pdf_corrupt');
    return { advanceY: data[0], vx: data[1], vy: data[2] };
  };
  for (let i = 0; i < values.length;) {
    const first = reader.number(values[i++], -1), next = values[i++];
    if (!Number.isInteger(first) || first < 0 || first > 65535 || !next) throw new PdfEngineError('Invalid CID vertical metric range.', 'pdf_corrupt');
    if (reader.node(next).kind === 'array') {
      const array = reader.array(next);
      if (array.length % 3 || first + array.length / 3 > 65536) throw new PdfEngineError('Invalid CID vertical metric array.', 'pdf_corrupt');
      chargeCidMetricWork(budget, array.length / 3);
      for (let j = 0; j < array.length; j += 3) metrics.set(first + j / 3, triple(array.slice(j, j + 3)));
    } else {
      const last = reader.number(next, -1), metric = triple(values.slice(i, i + 3)); i += 3;
      if (!Number.isInteger(last) || last < first || last > 65535) throw new PdfEngineError('Invalid CID vertical metric interval.', 'pdf_corrupt');
      chargeCidMetricWork(budget, last - first + 1);
      for (let cid = first; cid <= last; cid++) metrics.set(cid, metric);
    }
  }
  return Object.assign(cid => metrics.get(cid) ?? { advanceY: defaults[1], vx: width(cid) / 2, vy: defaults[0] },
    { resourceBytes: 16 + metrics.size * (64 + 8 + 3 * 8) });
}
