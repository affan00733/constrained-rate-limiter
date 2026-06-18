"""Constrained, in-memory API rate limiter (Flask port).

The `RateLimiter` core is framework-agnostic; only `init_app` touches Flask.
"""

from .limiter import RateLimiter

__all__ = ["RateLimiter"]
