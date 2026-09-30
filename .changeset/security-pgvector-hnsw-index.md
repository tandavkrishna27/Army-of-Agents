---
"@armyofagents/db": patch
---

feat(db): add HNSW index on `memory_items.embedding` for fast cosine-distance semantic memory retrieval. Closes C12 (the index was claimed in CLAUDE.md but never existed). Conditional on pgvector being installed; partial index skips NULL rows. HNSW chosen over IVFFlat for AoA's incremental ingest pattern. CLAUDE.md updated to reflect reality.
