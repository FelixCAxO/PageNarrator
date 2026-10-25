export function item(str, x, y, width, height = 12, metadata = {}) {
  return {
    str,
    transform: [1, 0, 0, 1, x, y],
    width,
    height,
    ...metadata,
  };
}
