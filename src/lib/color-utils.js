import { normalizeHighlightSettings } from './playback-settings.js';

export function hexToRgbString(color) {
  const normalized = normalizeHighlightSettings({ area: { color } }).area.color.slice(1);
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ].join(', ');
}

export function parseCssColor(value) {
  const color = String(value || '').trim();
  if (!/^rgba?\(/i.test(color)) return null;

  const match = color.match(/rgba?\((.*)\)/i);
  if (!match) return null;

  const parts = match[1]
    .replace(/\//g, ' ')
    .split(/[\s,]+/)
    .filter(Boolean);
  if (parts.length < 3) return null;

  const channels = parts.slice(0, 3).map(parseCssColorChannel);
  if (channels.some((channel) => !Number.isFinite(channel))) return null;

  const alpha = parts[3] == null ? 1 : parseCssAlpha(parts[3]);
  if (!Number.isFinite(alpha)) return null;

  return {
    red: channels[0],
    green: channels[1],
    blue: channels[2],
    alpha,
  };
}

function parseCssColorChannel(value) {
  const text = String(value || '').trim();
  const numeric = Number.parseFloat(text);
  if (!Number.isFinite(numeric)) return Number.NaN;
  return text.endsWith('%')
    ? Math.max(0, Math.min(255, (numeric / 100) * 255))
    : Math.max(0, Math.min(255, numeric));
}

function parseCssAlpha(value) {
  const text = String(value || '').trim();
  const numeric = Number.parseFloat(text);
  if (!Number.isFinite(numeric)) return Number.NaN;
  return text.endsWith('%')
    ? Math.max(0, Math.min(1, numeric / 100))
    : Math.max(0, Math.min(1, numeric));
}

export function isDarkColor(color) {
  const composited = compositeOverWhite(color);
  return relativeLuminance(composited) <= 0.2;
}

export function compositeOverWhite(color) {
  const alpha = Math.max(0, Math.min(1, color.alpha ?? 1));
  return {
    red: color.red * alpha + 255 * (1 - alpha),
    green: color.green * alpha + 255 * (1 - alpha),
    blue: color.blue * alpha + 255 * (1 - alpha),
  };
}

export function relativeLuminance(color) {
  const red = linearizeSrgb(color.red);
  const green = linearizeSrgb(color.green);
  const blue = linearizeSrgb(color.blue);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function linearizeSrgb(channel) {
  const value = Math.max(0, Math.min(255, channel)) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
