// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original worker benchmark. Options are handled by the shared actual-registry probe.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.argv.includes('--help')) {
  console.log('Original Kokoro registry/worker diagnostic benchmark\n'
    + '--backend wasm|webgpu|both  --mode stream|batch  --repeats 1..5\n'
    + '--case heart-connected|emma-connected  --cache <pinned-model-directory>  --output <report.json>\n'
    + 'GPU selection: PN_GPU_ADAPTER_LUID=<DXGI high,low> PN_GPU_VENDOR=intel|nvidia\n'
    + 'Uses fixed connected-prose inputs; reports audio-ready latency, completion, UI/engine counters and host occupancy. No acceptance or speedup claim.');
} else {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../probe-kokoro-registry.mjs', import.meta.url)), '--benchmark', ...process.argv.slice(2)],
    { stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
