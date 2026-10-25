// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { multiply } from './viewport.js';

const corrupt = () => { throw new PdfEngineError('Invalid PDF backdrop-independent contribution program.', 'pdf_corrupt'); };
const unsupported = () => { throw new PdfEngineError('This PDF backdrop-independent contribution program is not implemented.', 'pdf_unsupported'); };
const finite = (values, count) => Array.isArray(values) && values.length === count
  && Array.from(values).every(value => typeof value === 'number' && Number.isFinite(value));
const pathOperands = { m: 2, l: 2, c: 6, v: 4, y: 4, re: 4, h: 0 };

/** Validate the complete contribution before allocating a surface, even at alpha0.
 * ISO32000-1 11.4.4: Normal paints give Pfull=Ps+(1-ag)Pb. Removing the
 * backdrop therefore returns Ps, which a transparent scratch computes directly.
 * This does not change the declared non-isolated group into an isolated group.
 */
export function assertPdfCmykContributionGroup(group, check = () => {}) {
  if (!group || group.op !== 'group' || group.backdropIndependent !== true || group.isolated !== false
    || group.nativeColorSpace !== 'DeviceCMYK' || !(group.colorProfile instanceof Uint8Array) || !group.colorProfile.byteLength
    || !Number.isFinite(group.alpha) || group.alpha < 0 || group.alpha > 1 || !Array.isArray(group.commands)) corrupt();
  if (group.blend !== 'source-over' || group.softMask || group.knockout || group.alphaIsShape || group.fillOverprint || group.strokeOverprint) unsupported();
  if (group.commands.length > 500000) throw new PdfEngineError('PDF page operation budget exceeded.', 'pdf_limit');
  const stack = []; let matrix = [1, 0, 0, 1, 0, 0], hasPoint = false, ink = null;
  for (const command of group.commands) {
    check();
    if (!command || typeof command !== 'object') corrupt();
    if (command.op === 'save') {
      if (stack.length >= 64) throw new PdfEngineError('PDF graphics stack limit exceeded.', 'pdf_limit');
      stack.push(matrix);
    } else if (command.op === 'restore') { if (!stack.length) corrupt(); matrix = stack.pop(); }
    else if (command.op === 'transform') {
      if (!finite(command.args, 6)) corrupt();
      matrix = multiply(matrix, command.args); if (!finite(matrix, 6)) corrupt();
    }
    else if (command.op === 'color') {
      // Canonical contribution colours never carry mutable native painter state;
      // every fill instead has its complete checked native four-ink value.
      if ('nativeCmyk' in command || typeof command.fill !== 'boolean' || command.nativeColorSpace !== 'DeviceCMYK' || !finite(command.nativeColor, 3)) corrupt();
    } else if (command.op === 'path') {
      if (!Object.hasOwn(pathOperands, command.kind) || !finite(command.args, pathOperands[command.kind])) corrupt();
      if (!['m', 're'].includes(command.kind) && !hasPoint) corrupt();
      const points = command.kind === 're' ? [command.args[0], command.args[1], command.args[0] + command.args[2], command.args[1],
        command.args[0] + command.args[2], command.args[1] + command.args[3], command.args[0], command.args[1] + command.args[3]] : command.args;
      for (let i = 0; i < points.length; i += 2) {
        const x = matrix[0] * points[i] + matrix[2] * points[i + 1] + matrix[4], y = matrix[1] * points[i] + matrix[3] * points[i + 1] + matrix[5];
        if (!Number.isFinite(x) || !Number.isFinite(y)) corrupt();
      }
      hasPoint = true;
    } else if (command.op === 'paint') {
      if (![null, undefined, 'nonzero', 'evenodd'].includes(command.clip)) corrupt();
      if (command.fillPattern || command.strokePattern || command.softMask || command.nativeCmykStroke !== undefined
        || command.nativeCmykFillBlend !== undefined && command.nativeCmykFillBlend !== 'source-over'
        || command.nativeCmykStrokeBlend !== undefined || command.blend !== undefined && command.blend !== 'source-over') unsupported();
      hasPoint = false;
      if (command.kind === 'n') continue;
      if (!['f', 'F', 'f*'].includes(command.kind) || command.fillAlpha !== 1) unsupported();
      if (!finite(command.nativeCmykFill, 4) || command.nativeCmykFill.some(value => value < 0 || value > 1)) corrupt();
      if (ink && command.nativeCmykFill.some((value, index) => value !== ink[index])) unsupported();
      ink ??= command.nativeCmykFill;
    } else unsupported();
  }
  if (stack.length) corrupt();
  if (!ink) unsupported();
}
