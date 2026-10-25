// Harness-only evidence in the scanned PDF viewer, installed before product scripts.
export const PDF_OCR_SNAPSHOT_EXPRESSION = 'globalThis.__pnProbePdfOcr?.snapshot() ?? null';

export function forceProbePdfOcrCpu(profile = {}) {
  return profile.playbackSettings?.ttsBackendPreference === 'wasm' || profile.disableWebGpu === true;
}

export function createProbePdfOcrHooksSource(profile = {}) {
  return `(${installProbePdfOcrHooks.toString()})(${JSON.stringify(forceProbePdfOcrCpu(profile))});`;
}

// This observes only this PDF viewer realm. It creates no adapter, device or Worker.
function installProbePdfOcrHooks(forceCpu) {
  const counts = { requestAdapter: 0, requestDevice: 0, submit: 0 };
  const errors = [];
  const deviceAdapters = [];
  const timeOrigin = performance.timeOrigin;
  const fail = error => { if (errors.length < 8) errors.push(String(error?.message || error)); };
  const wrap = (target, key, count, observe = null) => {
    try {
      const original = target?.[key];
      if (typeof original !== 'function') throw new Error(`PDF OCR observation missing ${key}`);
      const replacement = function (...args) {
        const result = original.apply(this, args);
        counts[count] += 1;
        if (observe) { try { observe(this); } catch (error) { fail(error); } }
        return result;
      };
      Object.defineProperty(target, key, { configurable: true, writable: true, value: replacement });
      if (target[key] !== replacement) throw new Error(`PDF OCR observation did not install ${key}`);
    } catch (error) { fail(error); }
  };
  const gpu = navigator.gpu;
  if (gpu) {
    wrap(gpu, 'requestAdapter', 'requestAdapter');
    wrap(globalThis.GPUAdapter?.prototype, 'requestDevice', 'requestDevice', adapter => {
      if (deviceAdapters.length >= 16) throw new Error('PDF OCR adapter evidence limit exceeded');
      const info = adapter.info;
      deviceAdapters.push({ vendor: typeof info?.vendor === 'string' ? info.vendor : null,
        device: typeof info?.device === 'string' ? info.device : null,
        description: typeof info?.description === 'string' ? info.description : null,
        isFallbackAdapter: typeof adapter.isFallbackAdapter === 'boolean' ? adapter.isFallbackAdapter
          : typeof info?.isFallbackAdapter === 'boolean' ? info.isFallbackAdapter : null });
    });
    wrap(globalThis.GPUQueue?.prototype, 'submit', 'submit');
  }
  if (forceCpu) {
    // Match the existing CPU OCR helper's realm-scoped capability disable.
    for (const target of [globalThis.Navigator?.prototype, navigator]) {
      if (!target) continue;
      try { Object.defineProperty(target, 'gpu', { configurable: true, get() { return undefined; } }); }
      catch (error) { fail(error); }
    }
    if (navigator.gpu !== undefined) fail(new Error('CPU OCR selection did not hide WebGPU'));
  }
  globalThis.__pnProbePdfOcr = {
    snapshot() {
      return { contractVersion: 1, timeOrigin, forceCpu, effectiveGpuAvailable: Boolean(navigator.gpu),
        counts: { ...counts }, deviceAdapters: deviceAdapters.map(info => ({ ...info })), errors: [...errors] };
    },
  };
}

export function summarizeProbePdfOcr({ documentType, profile = {}, before, after } = {}) {
  if (documentType !== 'scanned-pdf') return { applicable: false, usesGpu: false, failures: [] };
  const failures = [];
  const forceCpu = forceProbePdfOcrCpu(profile);
  const valid = snapshot => snapshot?.contractVersion === 1 && Number.isFinite(snapshot.timeOrigin)
    && typeof snapshot.forceCpu === 'boolean' && typeof snapshot.effectiveGpuAvailable === 'boolean'
    && Array.isArray(snapshot.errors) && snapshot.errors.every(error => typeof error === 'string')
    && Array.isArray(snapshot.deviceAdapters) && snapshot.deviceAdapters.length <= 16
    && snapshot.deviceAdapters.length === snapshot.counts?.requestDevice
    && ['requestAdapter', 'requestDevice', 'submit'].every(key => Number.isSafeInteger(snapshot.counts?.[key]) && snapshot.counts[key] >= 0);
  if (!valid(before) || !valid(after)) failures.push('scanned PDF OCR backend observation is unavailable or invalid');
  const deltas = {};
  if (!failures.length) {
    if (before.timeOrigin !== after.timeOrigin) failures.push('scanned PDF OCR viewer changed during the read');
    if (before.forceCpu !== forceCpu || after.forceCpu !== forceCpu) failures.push('scanned PDF OCR selection does not match the profile');
    if (before.errors.length || after.errors.length) failures.push('scanned PDF OCR observation reported an error');
    if (JSON.stringify(before.deviceAdapters) !== JSON.stringify(after.deviceAdapters.slice(0, before.deviceAdapters.length))) failures.push('scanned PDF OCR adapter evidence changed during the read');
    for (const key of ['requestAdapter', 'requestDevice', 'submit']) {
      deltas[key] = after.counts[key] - before.counts[key];
      if (deltas[key] < 0) failures.push(`scanned PDF OCR ${key} counter reset during the read`);
    }
    if (forceCpu && (before.effectiveGpuAvailable || after.effectiveGpuAvailable
      || Object.values(after.counts).some(count => count !== 0))) failures.push('CPU OCR selection contradicted by WebGPU capability or calls');
  }
  return { applicable: true, contractVersion: 1, forceCpu, before, after, deltas,
    // Any observed device request or submission requires selected-adapter telemetry.
    usesGpu: (deltas.requestDevice || 0) > 0 || (deltas.submit || 0) > 0,
    submittedGpuWork: (deltas.submit || 0) > 0, failures,
    scope: 'PDF viewer realm only; no worker-native run, neural attribution, warm OCR computation or CPU-only hardware claim' };
}

// Actual OCR adapter identity comes from the receiver of requestDevice. Missing
// WebGPU PCI/fallback fields stay missing; DXGI and the launch binding constrain them.
export function probePdfOcrAdapterFailures(ocr, selection, profile = {}, launch = null) {
  if (!ocr?.usesGpu) return [];
  const failures = [];
  const pciId = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value
    : typeof value === 'string' && /^(?:0x)?[0-9a-f]{4,8}$/i.test(value) ? Number.parseInt(value.replace(/^0x/i, ''), 16) : null;
  const vendorId = value => value === 'intel' ? 0x8086 : value === 'nvidia' ? 0x10de : pciId(value);
  const rawLuid = row => Number.isInteger(row?.luidHigh) && row.luidHigh >= -2147483648 && row.luidHigh <= 2147483647
    && Number.isInteger(row?.luidLow) && row.luidLow >= 0 && row.luidLow <= 4294967295;
  const chromeLuid = row => `${row.luidHigh},${row.luidLow}`;
  const counterLuid = row => [row.luidHigh, row.luidLow].map(n => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`).join('_');
  const validRow = row => rawLuid(row) && pciId(row.vendorId) !== null && pciId(row.deviceId) !== null
    && typeof row.software === 'boolean' && row.chromeLuid === chromeLuid(row) && row.counterLuid === counterLuid(row);
  const selectedVendor = vendorId(selection?.vendorId), selectedDevice = pciId(selection?.deviceId);
  const expectedVendor = profile.gpuAdapter?.expectedVendor || profile.evidence?.selected?.gpuAdapter?.expectedVendor;
  if (!validRow(selection) || selection.software !== false) failures.push('OCR GPU has no valid selected physical adapter and raw/counter LUID binding');
  if (expectedVendor && vendorId(expectedVendor) !== selectedVendor) failures.push('OCR GPU launch binding does not match the requested profile');
  const rows = selection?.allAdapters;
  const validInventory = selection?.inventoryComplete === true && Array.isArray(selection.inventoryErrors) && selection.inventoryErrors.length === 0
    && Array.isArray(rows) && rows.length > 0 && rows.every(validRow)
    && new Set(rows.map(row => row.counterLuid)).size === rows.length;
  if (!validInventory) failures.push('OCR GPU physical adapter inventory is unavailable, incomplete or ambiguous');
  const candidates = validInventory ? rows.filter(row => row.vendorId === selectedVendor) : [];
  if (candidates.length !== 1 || candidates[0]?.software !== false) failures.push('OCR GPU vendor does not identify exactly one physical adapter');
  const unique = candidates[0];
  if (unique && (unique.deviceId !== selectedDevice || unique.luidHigh !== selection?.luidHigh || unique.luidLow !== selection?.luidLow
    || unique.counterLuid !== selection?.counterLuid || unique.chromeLuid !== selection?.chromeLuid)) failures.push('OCR GPU inventory does not match the selected PCI and LUID identities');
  const flags = launch?.args?.filter?.(arg => typeof arg === 'string' && /^--use-adapter-luid(?:=|$)/.test(arg));
  if (launch?.supervisor !== 'windows-job' || !Array.isArray(flags) || flags.length !== 1
    || flags[0] !== `--use-adapter-luid=${selection?.chromeLuid}`) failures.push('OCR GPU exact selected-adapter launch flag is unavailable or conflicting');
  const adapters = ocr.after?.deviceAdapters;
  if (!Array.isArray(adapters) || !adapters.length) failures.push('OCR GPU requestDevice adapter identity was not observed');
  for (const info of adapters || []) {
    if (vendorId(typeof info?.vendor === 'string' ? info.vendor.toLowerCase() : null) !== selectedVendor) failures.push('OCR GPU observed vendor differs from the selected unique physical adapter');
    if (info?.device !== '' && info?.device !== null && info?.device !== undefined && pciId(info.device) !== selectedDevice) failures.push('OCR GPU nonempty device ID conflicts with the selected physical adapter');
    if (info?.isFallbackAdapter === true || info?.software === true) failures.push('OCR GPU reports a software or fallback adapter');
    else if (info?.isFallbackAdapter !== false && info?.isFallbackAdapter !== null) failures.push('OCR GPU fallback evidence has an invalid representation');
  }
  return [...new Set(failures)];
}
