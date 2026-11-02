// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Disable the native uploader before initialization: Windows DLL teardown can wait on stopped workers.
process.env.ORT_DISABLE_TELEMETRY = '1';

const oracle = await import('onnxruntime-node');
export default oracle;
