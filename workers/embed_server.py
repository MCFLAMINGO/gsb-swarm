#!/usr/bin/env python3
"""DEPRECATED — do not run or extend.

File-based all-MiniLM-L6-v2 sidecar was a parallel semantic build.
Canonical embedder is Railway service eloquent-energy (nomic-embed-text-v1)
consumed via lib/embedderClient.js → businesses.embedding (pgvector).

See docs/DEPRECATIONS.md.
"""
import sys
print(
    "[embed_server] DEPRECATED — refused to start. "
    "Use Railway eloquent-energy + lib/embedderClient.js.",
    file=sys.stderr,
    flush=True,
)
sys.exit(1)
