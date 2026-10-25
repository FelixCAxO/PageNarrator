// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { parseIccProfile } from './icc-color.js';
import { multiply } from './viewport.js';
import { createPdfNativeCmykImageSampler } from './native-cmyk-image.js';

export const PDF_ICC4_CONTRIBUTION = 'normal-icc4-v1';
const corrupt = () => { throw new PdfEngineError('Invalid PDF normal ICC4 contribution program.', 'pdf_corrupt'); };
const unsupported = () => { throw new PdfEngineError('This PDF normal ICC4 contribution program is not implemented.', 'pdf_unsupported'); };
const limit = () => { throw new PdfEngineError('PDF normal ICC4 contribution program limit exceeded.', 'pdf_limit'); };
const identity = [1, 0, 0, 1, 0, 0];
const finite = (a, n) => Array.isArray(a) && a.length === n && Array.from(a).every(v => typeof v === 'number' && Number.isFinite(v));
const pathOperands = { m: 2, l: 2, c: 6, v: 4, y: 4, re: 4, h: 0 };
const normal = value => value === undefined || value === 'source-over';

/** Only an exact canonical source/target identity preserves encoded four inks.
 * There is deliberately no inferred inverse or uncalibrated conversion here.
 */
export function pdfIcc4SourceValues(space, values, profileBytes) {
  if (space?.name !== 'ICCBased' || space.components !== 4 || space.profileBytes !== profileBytes) unsupported();
  if (!finite(values, 4)) corrupt();
  return values.map(v => Math.max(0, Math.min(1, v)));
}

function pointsFinite(matrix, points) {
  if (!finite(matrix, 6)) corrupt();
  for (let i = 0; i < points.length; i += 2) {
    const x = matrix[0] * points[i] + matrix[2] * points[i + 1] + matrix[4];
    const y = matrix[1] * points[i] + matrix[3] * points[i + 1] + matrix[5];
    if (!Number.isFinite(x) || !Number.isFinite(y)) corrupt();
  }
}

/** ISO32000-1 11.4.4: for Normal/no-knockout paints,
 * Pfull=Ps+(1-ag)Pb. Independent group masks/opacity scale (Ps,ag), so
 * nested same-profile source contributions are closed under source-over.
 * The original I=false declaration is retained, not reinterpreted as I=true.
 * Validate the entire graph before any surface allocation or alpha0 return.
 */
export function assertPdfIcc4ContributionGroup(group, { check = () => {}, mask = null, pageTransform = identity, deviceExtent = null, surfaceBudget = { pixels: 0 }, profileCache = new WeakMap() } = {}) {
  check();
  const active = new Set(); let visits = 0, maximumDepth = 0, workUnits = 1;
  const profileBytes = group?.colorProfile;
  if (!(profileBytes instanceof Uint8Array) || !profileBytes.byteLength || !finite(pageTransform, 6)) corrupt();
  if (!profileCache.has(profileBytes)) profileCache.set(profileBytes, parseIccProfile(profileBytes));
  const profile = profileCache.get(profileBytes);
  if (profile.channels !== 4 || typeof profile.toXyz !== 'function') unsupported();
  const visit = (target, depth) => {
    check(); if (depth > 16) limit();
    maximumDepth = Math.max(maximumDepth, depth + 1);
    if (!target || typeof target !== 'object' || active.has(target)) corrupt();
    if (target.op !== 'group' || target.sourceContribution !== PDF_ICC4_CONTRIBUTION || 'backdropIndependent' in target || 'rgbCompatibility' in target
      || target.isolated !== false || target.nativeColorSpace !== 'ICCBased4' || target.colorProfile !== profileBytes
      || !Number.isFinite(target.alpha) || target.alpha < 0 || target.alpha > 1 || !Array.isArray(target.commands)) corrupt();
    if (target.softMask !== null && target.softMask !== undefined && (typeof target.softMask !== 'object' || Array.isArray(target.softMask))) corrupt();
    if (target.knockout || target.fillOverprint || target.strokeOverprint || (depth ? !normal(target.blend) : !['source-over', 'multiply'].includes(target.blend))) unsupported();
    if (target.softMask) {
      if (target.softMask.profileBytes !== profileBytes || target.softMask.nativeColorSpace !== 'ICCBased4') throw new PdfEngineError('ICC4 luminosity mask profile must match its contribution target exactly.', 'pdf_unsupported');
      if (mask) mask(target.softMask); // Constructor preflights functions, basis and absent-BC extent, without sampling.
      workUnits++;
    }
    active.add(target);
    let matrix = identity, hasPoint = false, paints = 0; const stack = [];
    for (const command of target.commands) {
      check(); if (++visits > 500000) limit();
      if (!command || typeof command !== 'object') corrupt();
      if (command.op === 'save') { if (stack.length >= 64) limit(); stack.push(matrix); }
      else if (command.op === 'restore') { if (!stack.length) corrupt(); matrix = stack.pop(); }
      else if (command.op === 'transform') {
        if (!finite(command.args, 6)) corrupt(); matrix = multiply(matrix, command.args); if (!finite(matrix, 6)) corrupt();
      } else if (command.op === 'color') {
        if ('nativeCmyk' in command || typeof command.fill !== 'boolean' || command.nativeColorSpace !== 'ICCBased4' || !finite(command.nativeColor, 3)) corrupt();
      } else if (command.op === 'path') {
        if (!Object.hasOwn(pathOperands, command.kind) || !finite(command.args, pathOperands[command.kind])) corrupt();
        if (!['m', 're'].includes(command.kind) && !hasPoint) corrupt();
        const a = command.args;
        const points = command.kind === 're' ? [a[0], a[1], a[0] + a[2], a[1], a[0] + a[2], a[1] + a[3], a[0], a[1] + a[3]] : a;
        pointsFinite(multiply(pageTransform, matrix), points); hasPoint = true;
      } else if (command.op === 'paint') {
        if (![null, undefined, 'nonzero', 'evenodd'].includes(command.clip)) corrupt();
        if (command.fillPattern || command.strokePattern || command.softMask || command.nativeCmykStroke !== undefined
          || !normal(command.nativeCmykFillBlend) || command.nativeCmykStrokeBlend !== undefined || !normal(command.blend)) unsupported();
        hasPoint = false; if (command.kind === 'n') continue;
        if (!['f', 'F', 'f*'].includes(command.kind) || command.fillAlpha !== 1) unsupported();
        if (!finite(command.nativeCmykFill, 4) || command.nativeCmykFill.some(v => v < 0 || v > 1)) corrupt();
        paints++; workUnits++;
      } else if (command.op === 'image') {
        if (command.format !== 'native-icc4' || command.colorSpace?.profileBytes !== profileBytes || command.alpha !== 1 || !normal(command.blend) || command.softMask) unsupported();
        if (!finite(command.matrix, 6)) corrupt();
        pointsFinite(multiply(pageTransform, command.matrix), [0, 0, 1, 0, 1, 1, 0, 1]);
        const sampler = createPdfNativeCmykImageSampler(command, { imageMatrix: command.matrix, pageTransform, surfaceBudget, cancellation: check }); sampler.destroy(); paints++; workUnits += 2;
      } else if (command.op === 'group') { visit(command, depth + 1); paints++; workUnits++; }
      else unsupported();
    }
    if (stack.length || !paints) corrupt();
    active.delete(target);
  };
  visit(group, 0);
  if (deviceExtent !== null) {
    if (!finite(deviceExtent, 4) || !deviceExtent.every(Number.isSafeInteger) || deviceExtent[0] !== 0 || deviceExtent[1] !== 0 || deviceExtent[2] < 1 || deviceExtent[3] < 1
      || !Number.isSafeInteger(surfaceBudget.pixels) || surfaceBudget.pixels < 0 || !Number.isSafeInteger(surfaceBudget.shadingPixels ?? 0) || (surfaceBudget.shadingPixels ?? 0) < 0) corrupt();
    const pixels = deviceExtent[2] * deviceExtent[3], live = surfaceBudget.pixels + maximumDepth * pixels * 7 + 8;
    const work = (surfaceBudget.shadingPixels ?? 0) + workUnits * pixels;
    // Whole-page worst-case work is conservative; actual paint bounds still
    // charge the shared ledger. Adaptive bands need at least8 scratch units.
    if (!Number.isSafeInteger(live) || live > 16_000_000 || !Number.isSafeInteger(work) || work > 64_000_000) limit();
  }
}
