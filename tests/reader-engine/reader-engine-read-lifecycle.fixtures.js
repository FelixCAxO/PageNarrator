export function createPageStream(chunk) {
  let returned = false;
  let yielded = false;

  const iterator = {
    async next() {
      if (returned || yielded) return { done: true };
      yielded = true;
      return { done: false, value: chunk };
    },
    async return() {
      returned = true;
      return { done: true };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  return {
    iterator,
    get returned() {
      return returned;
    },
  };
}
