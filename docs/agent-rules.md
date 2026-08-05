# Forge Rules

## Purpose
Forge binds material claims to evidence, checks, criteria, and durable signoff state.
Keep model assertions distinct from trusted executable or host evidence.

## Canonical sources
- Read `README.md` for lifecycle and trust behavior.
- Read `FORGE-MASTER.md` for adjudicated contracts.
- Read `docs/architecture.md` and `docs/integration-matrix.md` for adapters and flows.
- Read `docs/store-migration.md` before persistence changes.

## Commands
- Run `pnpm test` for the full Node suite.
- Run `pnpm mcp` for the MCP server surface.
- Run `node cli.js doctor` for installed store and host-token health.
- Run focused adapter tests after Claude or Codex hook changes.

## Locked invariants
- Let only issuer-derived trusted evidence satisfy repository and check policy.
- Block signoff while critical or material claims remain open or stale.
- Bind checks to rubric criteria and exact specifications.
- Invalidate evidence when its file, lockfile, worktree, or external revision changes.
- Keep stores local, owner-only, append-only, content-addressed, and atomically written.
- Derive trusted callers from owner-only host tokens rather than environment claims.
- Preserve neutral allow, continue, block, and noop adapter decisions across clients.
- Keep deprecated v1 surfaces disabled outside explicit migration tests.

## Verification
- Run focused core, store, gate, and adapter tests before `pnpm test`.
- Prove close idempotency against unchanged ledger hashes.
- Test stale evidence, blind retries, and untrusted model claims as negative cases.
