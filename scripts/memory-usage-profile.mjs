const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB'];

export async function profileMemorySteps(steps, {
  readMemoryUsage = readRuntimeMemoryUsage,
  now = defaultNow,
  forceGarbageCollection = null,
} = {}) {
  if (!Array.isArray(steps)) {
    throw new TypeError('profileMemorySteps requires an array of steps.');
  }

  const reports = [];

  for (const step of steps) {
    if (!step?.name || typeof step.run !== 'function') {
      throw new TypeError('Each memory profile step must have a name and run function.');
    }

    const before = await readSnapshot({ readMemoryUsage, forceGarbageCollection });
    const startedAtMs = Number(now());
    await step.run();
    const endedAtMs = Number(now());
    const after = await readSnapshot({ readMemoryUsage, forceGarbageCollection });

    reports.push(createStepReport({
      name: step.name,
      before,
      after,
      durationMs: endedAtMs - startedAtMs,
    }));
  }

  return reports;
}

export function readRuntimeMemoryUsage({
  performance = globalThis.performance,
  process = globalThis.process,
} = {}) {
  const browserMemory = performance?.memory;
  const browserUsedBytes = normalizeByteCount(browserMemory?.usedJSHeapSize);

  if (browserUsedBytes !== null) {
    return {
      usedBytes: browserUsedBytes,
      totalBytes: normalizeByteCount(browserMemory?.totalJSHeapSize),
      limitBytes: normalizeByteCount(browserMemory?.jsHeapSizeLimit),
      source: 'performance.memory',
    };
  }

  if (typeof process?.memoryUsage === 'function') {
    const usage = process.memoryUsage();
    return {
      usedBytes: normalizeByteCount(usage.heapUsed),
      totalBytes: normalizeByteCount(usage.heapTotal),
      rssBytes: normalizeByteCount(usage.rss),
      externalBytes: normalizeByteCount(usage.external),
      arrayBuffersBytes: normalizeByteCount(usage.arrayBuffers),
      source: 'process.memoryUsage',
    };
  }

  return {
    usedBytes: null,
    totalBytes: null,
    rssBytes: null,
    source: 'unavailable',
  };
}

export function summarizeMemoryUsage(reports) {
  const entries = Array.isArray(reports) ? reports : [];
  const first = entries[0];
  const last = entries.at(-1);
  const totalDeltaBytes = Number.isFinite(first?.beforeBytes) && Number.isFinite(last?.afterBytes)
    ? last.afterBytes - first.beforeBytes
    : sumFinite(entries.map((report) => report.deltaBytes));

  const largestIncrease = entries
    .filter((report) => Number.isFinite(report.deltaBytes) && report.deltaBytes > 0)
    .sort((a, b) => b.deltaBytes - a.deltaBytes)[0];

  return {
    totalDeltaBytes,
    largestIncrease: largestIncrease
      ? {
          name: largestIncrease.name,
          deltaBytes: largestIncrease.deltaBytes,
        }
      : null,
  };
}

export function formatMemoryBytes(bytes) {
  if (bytes == null) return 'n/a';
  const numericBytes = Number(bytes);
  if (!Number.isFinite(numericBytes)) return 'n/a';

  const sign = numericBytes < 0 ? '-' : '';
  let value = Math.abs(numericBytes);
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  if (unitIndex === 0) return `${sign}${Math.round(value)} ${BYTE_UNITS[unitIndex]}`;
  return `${sign}${value.toFixed(1)} ${BYTE_UNITS[unitIndex]}`;
}

async function readSnapshot({ readMemoryUsage, forceGarbageCollection }) {
  if (typeof forceGarbageCollection === 'function') {
    forceGarbageCollection();
  }
  return normalizeSnapshot(await readMemoryUsage());
}

function createStepReport({ name, before, after, durationMs }) {
  const report = {
    name,
    beforeBytes: before.usedBytes,
    afterBytes: after.usedBytes,
    deltaBytes: subtractByteCounts(after.usedBytes, before.usedBytes),
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    source: after.source || before.source || 'unknown',
  };

  if (before.rssBytes !== null || after.rssBytes !== null) {
    report.rssBeforeBytes = before.rssBytes;
    report.rssAfterBytes = after.rssBytes;
    report.rssDeltaBytes = subtractByteCounts(after.rssBytes, before.rssBytes);
  }

  return report;
}

function normalizeSnapshot(snapshot = {}) {
  return {
    usedBytes: normalizeByteCount(snapshot.usedBytes),
    totalBytes: normalizeByteCount(snapshot.totalBytes),
    limitBytes: normalizeByteCount(snapshot.limitBytes),
    rssBytes: normalizeByteCount(snapshot.rssBytes),
    externalBytes: normalizeByteCount(snapshot.externalBytes),
    arrayBuffersBytes: normalizeByteCount(snapshot.arrayBuffersBytes),
    source: String(snapshot.source || 'unknown'),
  };
}

function normalizeByteCount(value) {
  if (value == null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.round(numeric);
}

function subtractByteCounts(afterBytes, beforeBytes) {
  if (!Number.isFinite(afterBytes) || !Number.isFinite(beforeBytes)) return null;
  return afterBytes - beforeBytes;
}

function sumFinite(values) {
  return values.reduce((sum, value) => (
    Number.isFinite(value) ? sum + value : sum
  ), 0);
}

function defaultNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}
