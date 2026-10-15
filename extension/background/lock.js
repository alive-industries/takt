const tails = new Map();

export function withLock(key, fn) {
  const previous = tails.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  tails.set(key, tail);
  return run.finally(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
}
