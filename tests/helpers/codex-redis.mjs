export const createCodexTestRedis = () => {
  const values = new Map();
  const hashes = new Map();
  return {
    values,
    hashes,
    async get(key) { return values.get(key) ?? null; },
    async set(key, value, ...options) {
      if (options.includes("NX") && values.has(key)) return null;
      values.set(key, value);
      return "OK";
    },
    async hget(key, field) { return hashes.get(key)?.get(field) ?? null; },
    async hset(key, field, value) {
      if (!hashes.has(key)) hashes.set(key, new Map());
      hashes.get(key).set(field, value);
      return 1;
    },
    async hgetall(key) { return Object.fromEntries(hashes.get(key) || []); },
    async eval(_script, _count, key, token) {
      if (values.get(key) !== token) return 0;
      values.delete(key);
      return 1;
    },
  };
};
