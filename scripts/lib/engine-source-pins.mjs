// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function engineSourcePins(root, extra = []) {
  const files = [...(await readdir(resolve(root, 'src/engines'))).filter(name => name.endsWith('.js')).map(name => `src/engines/${name}`),
    'public/native/engine.wasm', 'public/native/engine.json', ...extra].sort();
  return Object.fromEntries(await Promise.all(files.map(async file => [file,
    createHash('sha256').update(await readFile(resolve(root, file))).digest('hex')])));
}
