function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function createChromeStub(initialStorage = {}) {
  const storage = clone(initialStorage);
  const delay = () => new Promise((resolve) => setTimeout(resolve, 0));

  const chrome = {
    storage: {
      local: {
        async get(keys) {
          await delay();
          if (typeof keys === 'string') {
            return { [keys]: clone(storage[keys]) };
          }
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map((key) => [key, clone(storage[key])]));
          }
          if (keys && typeof keys === 'object') {
            return Object.fromEntries(
              Object.entries(keys).map(([key, fallback]) => [
                key,
                clone(storage[key] === undefined ? fallback : storage[key]),
              ])
            );
          }
          return clone(storage);
        },
        async set(values) {
          await delay();
          Object.assign(storage, clone(values));
        },
        async clear() {
          await delay();
          for (const key of Object.keys(storage)) delete storage[key];
        },
      },
    },
    alarms: {
      create() {},
      clear() {},
      onAlarm: { addListener() {} },
    },
    runtime: {
      getManifest: () => ({ version: 'test' }),
    },
  };

  return { chrome, storage };
}
