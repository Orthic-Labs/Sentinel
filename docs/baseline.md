# Phase 0 baseline

The existing v1.1 telemetry corpus contains local content-free JSONL files under
`tools/.cache/metrics/reflect/`. The v2 implementation keeps the same bounded telemetry path and
opt-out (`REFLECT_TELEMETRY_ENABLED=0`). v1.1 regression coverage remains in `test.mjs`; its launch
sets `REFLECT_LEGACY_TOOLS=1` so the compatibility behavior is exercised explicitly.

The v2 acceptance baseline is measured by the future eval harness: repeated-identical-retry rate,
false versus genuine signoff blocks, unsupported material API claims, and token cost. No unmeasured
success-rate claim is published here.
