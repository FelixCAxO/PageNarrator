export function installRecoverableWebGpuErrorSuppression(windowRef = globalThis.window) {
  if (!windowRef?.addEventListener) return false;

  windowRef.addEventListener('unhandledrejection', (event) => {
    if (isRecoverableWebGpuAdapterError(event?.reason)) event.preventDefault?.();
  });
  return true;
}

function isRecoverableWebGpuAdapterError(reason) {
  const message = String(reason?.message || reason || '');
  return /No available adapters/i.test(message);
}
