// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Larger intervals choose a slot first; views keep an interval open until its last owner retires.
export function planGpuWorkspace(intervals) {
  const slots = [], assignments = new Array(intervals.length);
  for (const item of intervals.map((interval, index) => ({ ...interval, index })).sort((a, b) => b.bytes - a.bytes || a.start - b.start)) {
    let slot = slots.find(candidate => candidate.capacity >= item.bytes
      && candidate.items.every(other => item.start >= other.end || other.start >= item.end));
    if (!slot) { slot = { capacity: item.bytes, index: slots.length, items: [] }; slots.push(slot); }
    slot.items.push(item); assignments[item.index] = slot.index;
  }
  return Object.freeze({ capacities: Object.freeze(slots.map(slot => slot.capacity)), slots: Object.freeze(assignments) });
}
