# Phase 0 baseline

The existing v1.1 telemetry corpus contains local content-free JSONL files under
`tools/.cache/metrics/reflect/`, written before the product was renamed. v2 writes to
`tools/.cache/metrics/sentinel/` with the same bounded format and opt-out
(`SENTINEL_TELEMETRY_ENABLED=0`), so read both paths when computing the Phase 0 baseline — the older
directory is the pre-rename history and is not migrated. v1.1 regression coverage remains in
`test.mjs`; its launch sets `SENTINEL_LEGACY_TOOLS=1` so the compatibility behavior is exercised
explicitly.

The v2 acceptance baseline is measured by the future eval harness: repeated-identical-retry rate,
false versus genuine signoff blocks, unsupported material API claims, and token cost. No unmeasured
success-rate claim is published here.
