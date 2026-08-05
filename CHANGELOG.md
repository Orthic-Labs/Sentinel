# Changelog

## 2.0.1 (unreleased)

### P0 (prior)
- Trust boundary: host token file replaces `FORGE_TRUSTED_CALLER`; default store moves to host data directory with legacy `.forge/` fallback (`docs/store-migration.md`).
- Enforcement: unbound validation paths return `enforcement_degraded`; PostToolUse no longer auto-records passing checks.
- Gating: `evaluateGate` uses rubric criteria; checks require criterion link + CheckSpec match; supported claims require matching evidence class.

### P1
- Incremental `loadEvents` projection (byte cursor + in-memory index); durable tables fsync immediately; `retry_budget` / failures batch fsync.
- Stop distinguishes conversational stop vs `completion_intent` / `task_complete`; completion runs verify then transactional close.
- Sole-open-run session heuristic removed; bindings require explicit `run_id` (or existing session/task binding) plus optional workspace hash.
- Locator parser is Windows-drive safe; ranged/`#symbol` locators hash the region (not only the whole file).
- MCP schema strips model-writable `trust_class` / `executor` / `status`; values are issuer-derived.
- Retry fingerprints use normalized command + error class + exit code + mutation (not raw command hash alone).

### P2
- Minimal `execution_contract.check_specs` merged into criterion CheckSpec matching; optional `preflight` is a tiny stub (no process-tree watchdog).
- Blueprint orientation evidence acceptance + hook-point doc (`docs/blueprint-orientation.md`).
- Rename surfaces: `BeaconCore` (`ReflectCore` alias), `beacon`/`forge` bins + MCP tools, `BEACON_*`/`FORGE_*` env dual-alias, Codex hooks prefer `CODEX_PLUGIN_ROOT`, `init`/`doctor`, e2e lifecycle coverage.

## 2.0.0

- Added hooks-first enforcement, durable local state, claims/evidence, verification gates, CLI, and
  exact-version installed-source documentation lookup.
- Replaced the v1 MCP surface with `forge` and `docs`; legacy aliases are migration errors.
