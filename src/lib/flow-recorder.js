const FLOW_LOG_KEY = '__pnFlowLog';

/** @param {any} [deps] */
export function createFlowRecorder({
  enabled = false,
  target = globalThis,
  now = () => defaultNowSeconds(),
} = {}) {
  const isEnabled = () => (typeof enabled === 'function' ? Boolean(enabled()) : Boolean(enabled));

  return {
    record(entry = {}) {
      if (!isEnabled() || !target || typeof target !== 'object') return null;
      const event = {
        t: normalizeTimestamp(now()),
        ...pruneUndefined(entry),
      };
      getFlowLog(target).push(event);
      return event;
    },
  };
}

/** @param {any} [target] */
export function getFlowLog(target = globalThis) {
  if (!target || typeof target !== 'object') return [];
  if (!Array.isArray(target[FLOW_LOG_KEY])) target[FLOW_LOG_KEY] = [];
  return target[FLOW_LOG_KEY];
}

export function normalizeFlowToken(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\u00df/g, 'ss')
    .replace(/[^\p{L}\p{N}'-]/gu, '');
}

function defaultNowSeconds() {
  const performanceNow = globalThis.performance?.now?.();
  if (Number.isFinite(performanceNow)) return performanceNow / 1000;
  return Date.now() / 1000;
}

function normalizeTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : defaultNowSeconds();
}

/** @param {any} entry */
function pruneUndefined(entry) {
  const result = {};
  for (const [key, value] of Object.entries(entry || {})) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}
