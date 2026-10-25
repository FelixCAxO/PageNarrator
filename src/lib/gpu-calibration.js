export async function selectVoiceModelBackend({
  navigator = globalThis.navigator,
  webGpuRuntimeAvailable = true,
  probeWebGpu = probeWebGpuBackend,
} = {}) {
  if (!webGpuRuntimeAvailable) return createWasmPlan('webgpu-runtime-unavailable');
  if (!navigator?.gpu) return createWasmPlan('no-webgpu');

  let probe;
  try {
    probe = await probeWebGpu({ navigator });
  } catch (error) {
    return { ...createWasmPlan('no-adapter'), adapterError: error?.message || String(error) };
  }
  if (probe?.available === false || probe?.reason === 'no-adapter' || probe?.reason === 'no-webgpu') {
    return { ...createWasmPlan(probe.reason || 'no-adapter'), probe };
  }

  // ponytail: try GPU inference first; RAM, core counts and synthetic scores do not decide availability.
  return { device: 'webgpu', dtype: 'fp32', reason: 'webgpu-available', cpuBudgetTarget: false, probe };
}

export async function probeWebGpuBackend({ navigator = globalThis.navigator } = {}) {
  if (!navigator?.gpu?.requestAdapter) return { available: false, reason: 'no-webgpu' };
  try {
    const adapter = await navigator.gpu.requestAdapter(createWebGpuRequestAdapterOptions(navigator));
    return { available: Boolean(adapter), reason: adapter ? 'webgpu-available' : 'no-adapter' };
  } catch (error) {
    return { available: false, reason: 'no-adapter', adapterError: error?.message || String(error) };
  }
}

export function createWebGpuRequestAdapterOptions(navigator = globalThis.navigator) {
  const platform = String(navigator?.userAgentData?.platform || navigator?.platform || '');
  return /^win/i.test(platform) ? undefined : { powerPreference: 'high-performance' };
}

function createWasmPlan(reason) {
  return { device: 'wasm', dtype: 'q8', reason, cpuBudgetTarget: true };
}
