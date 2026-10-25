// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// These are owned byte arrays; parser/WASM memory is never part of a payload.
export function pdfPayloadBuffers(payload) {
  const buffers = new Set(), commandsSeen = new Set(), functionsSeen = new Set(), add = value => { if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) buffers.add(value.buffer); };
  for (const font of payload.fonts || []) add(font.bytes);
  const pending = [...(payload.commands || [])];
  for (let index = 0; index < pending.length; index++) {
    const command = pending[index];
    if (commandsSeen.has(command)) continue;
    commandsSeen.add(command);
    for (const key of ['pixels', 'bytes', 'maskAlpha', 'colorProfile', 'outputProfile', 'colorLookup']) add(command[key]);
    add(command.colorSpace?.profileBytes);
    add(command.colorSpace?.alternate?.profileBytes);
    if (command.fillPattern) pending.push(command.fillPattern);
    if (command.strokePattern) pending.push(command.strokePattern);
    if (command.softMask) {
      add(command.softMask.bytes);
      add(command.softMask.profileBytes);
      add(command.softMask.deviceImage?.samples);
      if (command.softMask.shading) pending.push(command.softMask.shading);
    }
    if (command.functions || command.colorSpace?.tintTransform) {
      const functions = [...(command.functions || []), ...(command.colorSpace?.tintTransform ? [command.colorSpace.tintTransform] : [])];
      for (let i = 0; i < functions.length; i++) {
        const fn = functions[i]; if (functionsSeen.has(fn)) continue;
        functionsSeen.add(fn); add(fn.samples);
        if (fn.functions) for (const child of fn.functions) functions.push(child);
      }
    }
    if (command.commands) for (const child of command.commands) pending.push(child);
  }
  return [...buffers];
}

export const pdfPayloadByteLength = payload => pdfPayloadBuffers(payload).reduce((sum, buffer) => sum + buffer.byteLength, 0);
