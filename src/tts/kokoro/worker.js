// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { installKokoroWorker } from './worker-host.js';
import { loadBrowserKokoroBackend } from './model-loader.js';
import { createKokoroCpuPoolBridge } from './cpu-pool.js';

const cpu = createKokoroCpuPoolBridge(self);
installKokoroWorker(self, { loadBackend: (/** @type {string} */ modelId, /** @type {any} */ options) => loadBrowserKokoroBackend(modelId, { ...options, cpuEngineFactory: cpu.createEngine }) });
const receive = self.onmessage;
self.onmessage = event => { if (!cpu.receive(event.data)) receive?.call(self, event); };
