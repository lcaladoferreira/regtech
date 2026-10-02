# Fixtures boundary

This folder marks the explicit boundary for **synthetic development fixtures**.

- The development fixture loader lives in [`../../src/seed.js`](../../src/seed.js). It is only
  executed when `seedAllowed()` is true, i.e. **outside production** (`NODE_ENV !== production`
  and not on Vercel), and can be force-disabled with `LCF_ALLOW_SEED=false`.
- Seeded rows that describe internal systems, datasets, mappings, demo artifacts, DQ fixtures
  and the intentionally-invalid negative-control row are synthetic. They are labeled
  `is_demo = 1` at row level and are excluded from the LIVE data mode badge.
- Curated regulatory *excerpts* seeded alongside are real official text transcriptions with
  their source URL, but their hashes are `CURATED_EXCERPT_SHA256` (hash of the stored excerpt
  text), never hashes of original remote bytes.
- In production, none of this is loaded: production databases start empty and only contain
  records produced by real official-source ingestion or explicit, source-backed human entry.

Tests may add focused fixture files next to this README. Anything synthetic must remain under
this boundary or be tagged `is_demo`.
