"""In-memory bucket store — a dict, no Redis/DB (constraint).

dict preserves insertion order (CPython 3.7+), so we get LRU eviction for free
by re-inserting on access. Idle entries are swept by a background daemon thread.
"""


class InMemoryStore:
    def __init__(self, opts=None):
        opts = opts or {}
        self.map = {}
        self.max_idle_ms = opts.get("maxIdleMs", 120000)
        self.max_keys = opts.get("maxKeys", 100000)

    def get_or_create(self, key, now, create):
        s = self.map.get(key)
        if s is not None:
            del self.map[key]          # LRU bump: move to most-recent
            self.map[key] = s
            return s
        if len(self.map) >= self.max_keys:
            oldest = next(iter(self.map))
            del self.map[oldest]
        s = create(now)
        self.map[key] = s
        return s

    def sweep(self, now):
        dead = [k for k, v in list(self.map.items()) if now - v["last_seen"] > self.max_idle_ms]
        for k in dead:
            del self.map[k]
        return len(dead)

    def delete_by_prefix(self, prefix):
        keys = [k for k in self.map if (not prefix or k.startswith(prefix))]
        for k in keys:
            del self.map[k]
        return len(keys)

    def clear(self):
        n = len(self.map)
        self.map.clear()
        return n

    @property
    def size(self):
        return len(self.map)
