// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Verification processes only; never changes Windows or user browser preferences.
export function browserAdapterConfiguration(env = process.env) {
  const luid = env.PN_GPU_ADAPTER_LUID || '';
  if (luid && !/^-?\d+,\d+$/.test(luid)) throw new Error('Adapter LUID must be the DXGI high,low decimal pair.');
  const vendor = env.PN_GPU_VENDOR || '';
  if (vendor && !/^[a-z0-9-]+$/.test(vendor)) throw new Error('Expected GPU vendor must be a lowercase identifier.');
  return { args: luid ? ['--use-angle=d3d11', `--use-adapter-luid=${luid}`] : [],
    suffix: luid ? `-${vendor || 'adapter'}-${luid.replace(',', '-')}` : '', expectedVendor: vendor };
}

export function verifyBrowserAdapter(adapter, configuration) {
  if (configuration.expectedVendor && adapter?.vendor !== configuration.expectedVendor) {
    throw new Error(`Expected ${configuration.expectedVendor} GPU, received ${adapter?.vendor || 'no adapter'}.`);
  }
}
