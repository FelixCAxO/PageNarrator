export function normalizePositive(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function normalizeNonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function normalizePositiveInteger(value, fallback = 0) {
  return Math.trunc(normalizePositive(value, fallback));
}

export function normalizeNonNegativeInteger(value, fallback = 0) {
  return Math.trunc(normalizeNonNegative(value, fallback));
}

export function normalizePercent(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}
