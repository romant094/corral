// What an inline button does lives here, keyed by a short id in its
// callback_data (Telegram allows 64 bytes). Kept in memory only: after a
// restart old buttons answer "expired" instead of acting on stale state.
export function makeButtons(limit = 2000) {
  const entries = new Map();
  let n = 0;
  return {
    register(entry) {
      const id = `b${(++n).toString(36)}`;
      entries.set(id, entry);
      if (entries.size > limit) entries.delete(entries.keys().next().value);
      return id;
    },
    get: (id) => entries.get(id) ?? null,
    drop: (id) => entries.delete(id),
  };
}
