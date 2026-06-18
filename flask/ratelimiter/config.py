"""Config loader + resolver. The whole policy lives in a JSON file; the limiter
hot-reloads it when the file's mtime changes (see limiter.py), so limits are
adjustable without code changes — same contract as the Node version.
"""

import json

DEFAULT_ALGORITHM = "token-bucket"


def build_config(raw):
    tiers = raw.get("tiers", {})
    clients = raw.get("clients", {})
    default_tier = raw.get("defaultTier", "standard")
    algorithm = raw.get("algorithm", DEFAULT_ALGORITHM)

    read_methods = {m.upper() for m in raw.get("methodClasses", {}).get("read", ["GET", "HEAD", "OPTIONS"])}
    mult = {"read": 1, "write": 0.2, **raw.get("methodMultipliers", {})}
    overrides = [{**o, "method": o["method"].upper()} for o in raw.get("endpointOverrides", [])]
    skip_paths = set(raw.get("skipPaths", []))
    skip_prefixes = raw.get("skipPrefixes", [])
    ident = {"header": "x-api-key", "ipFallback": True, **raw.get("identification", {})}
    store = {"sweepIntervalMs": 30000, "maxIdleMs": 120000, "maxKeys": 100000, **raw.get("store", {})}
    admin = {"token": None, **raw.get("admin", {})}

    def tier_name_for(raw_id):
        t = clients.get(raw_id)
        return t if (t and t in tiers) else default_tier

    def rule_from(limit, window_ms, burst=None):
        cap = max(1, burst if burst is not None else limit)
        return {"capacity": cap, "refill_per_ms": limit / window_ms, "limit": limit, "window_ms": window_ms}

    def is_skipped(path):
        return path in skip_paths or any(path.startswith(p) for p in skip_prefixes)

    def resolve(principal, method, path):
        method = method.upper()
        if is_skipped(path):
            return {"skip": True}

        client_id = f'{principal["kind"]}:{principal["id"]}'
        tname = tier_name_for(principal["id"])
        tier = tiers.get(tname, {"limit": 100, "windowMs": 60000})

        # 1) explicit per-endpoint override
        for o in overrides:
            if o["method"] == method and o["path"] == path:
                return {
                    "key": f'{client_id}|ovr:{o["method"]}:{o["path"]}',
                    "scope": f'override {o["method"]} {o["path"]}',
                    "tier": tname,
                    "client_id": client_id,
                    "rule": rule_from(o["limit"], o.get("windowMs", tier["windowMs"]), o.get("burst")),
                }

        # 2) read vs write within the client's tier
        cls = "read" if method in read_methods else "write"
        limit = max(1, round(tier["limit"] * mult.get(cls, 1)))
        return {
            "key": f"{client_id}|{cls}",
            "scope": f"{cls} ({tname} tier)",
            "tier": tname,
            "client_id": client_id,
            "rule": rule_from(limit, tier["windowMs"], tier.get("burst")),
        }

    return {
        "resolve": resolve,
        "is_skipped": is_skipped,
        "ident": ident,
        "store": store,
        "admin": admin,
        "tiers": tiers,
        "algorithm": algorithm,
        "raw": raw,
    }


def load_config(path):
    with open(path, "r") as f:
        return build_config(json.load(f))
