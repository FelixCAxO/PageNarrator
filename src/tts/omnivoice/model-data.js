// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Model data only; pin changes require a new frozen model-quality evaluation.
export const OMNIVOICE_DATA = Object.freeze({
  modelId: 'MarkShark2/omnivoice-onnx-kv-b1-fp16',
  revision: '0111dd42766f32e6ebb91434ded76f0e697d834a',
  files: [
    { path: 'omnivoice-main-kv-fp16-b1.onnx_data', bytes: 1225140224, sha256: 'eb51c819645b595f8fe541e74e000c10808e391c185717122b167d53d45169bd' },
    { path: 'omnivoice-main-kv-fp16-b1-manifest.json', bytes: 39, sha256: '076fa845806ad2d1e5517ff0b08385757c996f2da56a6729c7011ea343ac067c' },
    { path: 'omnivoice-decoder-webgpu.onnx', bytes: 115922662, sha256: '12ddfca66e030e9ece90106d117a9b61ea25e64e510ca4c677e65d6ecabb9cc2' },
    { path: 'omnivoice-main-kv-fp16-b1.onnx', bytes: 1689189, sha256: 'cab55e2fe02dc4239cf9c6674cc8f83e41c645b96db92baa02d6515c90fe745e' },
    { path: 'omnivoice-config.json', bytes: 218, sha256: '8462ef0dba39e9204cc972391aa4655dc98625a09326e0d08a600ef38f486508' },
    { path: 'tokenizer_config.json', bytes: 533, sha256: '49f78845596a82bf15c83673794bdf9f76f812b11f60ab6a2239d9be65b00676' },
    { path: 'tokenizer.json', bytes: 11423986, sha256: '408f669b7e2b045fdf54201d815bd364e6667dbd845115da81239c40bc6dcfd1' },
  ],
});
