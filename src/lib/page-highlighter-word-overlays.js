import { REGION_OVERLAY_ATTRIBUTE } from './page-highlighter-region-overlay.js';

export function createPdfWordOverlayRenderer({
  enabled = false,
  documentRef = globalThis.document,
  flattenRanges = (ranges) => ranges,
  getRangeRects = () => [],
  ensurePinning = () => {},
  maxTrailLength = 4,
} = {}) {
  let overlays = [];
  let slots = [];

  function render(nextSlots = []) {
    if (!enabled) return;
    slots = nextSlots;
    const entries = slots.flatMap((slot, slotIndex) => flattenRanges(Array.isArray(slot) ? slot : [slot])
      .flatMap((range) => getRangeRects(range).map((rect) => ({ rect, slotIndex }))))
      .filter((entry) => entry.rect && entry.rect.width > 0 && entry.rect.height > 0);

    if (!entries.length) {
      clear();
      return;
    }

    const activeOverlays = getOverlays(entries.length);
    entries.forEach(({ rect, slotIndex }, index) => {
      const overlay = activeOverlays[index];
      const padding = 2;
      const opacitySlot = Math.min(slotIndex, maxTrailLength - 1);
      const color = `rgba(var(--pn-highlight-word-rgb), var(--pn-highlight-word-opacity-${opacitySlot}))`;
      overlay.style.setProperty('background', color, 'important');
      overlay.style.setProperty('border', '0', 'important');
      overlay.style.setProperty('border-radius', '3px', 'important');
      overlay.style.setProperty('box-shadow', `0 0 0 1px ${color}`, 'important');
      overlay.style.display = 'block';
      overlay.style.left = `${Math.round(rect.left - padding)}px`;
      overlay.style.top = `${Math.round(rect.top - padding)}px`;
      overlay.style.width = `${Math.round(rect.width + padding * 2)}px`;
      overlay.style.height = `${Math.round(rect.height + padding * 2)}px`;
    });
    ensurePinning();
  }

  function clear() {
    slots = [];
    for (const overlay of overlays) overlay.remove();
    overlays = [];
  }

  function reposition() {
    if (slots.length) render(slots);
  }

  function getOverlays(count) {
    for (let index = overlays.length - 1; index >= 0; index -= 1) {
      if (!overlays[index].isConnected) overlays.splice(index, 1);
    }

    while (overlays.length < count) {
      const overlay = documentRef.createElement('div');
      overlay.setAttribute(REGION_OVERLAY_ATTRIBUTE, 'word');
      overlay.setAttribute('aria-hidden', 'true');
      overlay.dataset.pagenarratorWordIndex = String(overlays.length);
      documentRef.documentElement.appendChild(overlay);
      overlays.push(overlay);
    }

    for (let index = overlays.length - 1; index >= count; index -= 1) {
      overlays[index].remove();
      overlays.pop();
    }

    return overlays;
  }

  return { render, clear, reposition };
}
