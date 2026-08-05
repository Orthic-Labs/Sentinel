# Historical store migration — completed 2026-08-02

This dated migration record has no live compatibility path. Current Forge accepts no legacy bin, MCP tool, class, environment, store-root, or bearer-token alias.

## Current contract

| Surface | Canonical contract |
|---|---|
| Host data | `~/Library/Application Support/forge/` on macOS, with `FORGE_HOST_DATA` only for host-controlled test or integration environments |
| Store | `<host-data>/stores/<project-hash>/`; never a repository-local default |
| Trusted authority | `--host-stdio` with a verified Developer-ID-signed CodeRight parent; shell invocations always receive model authority |
| CLI / MCP / core | `forge`, `forge-cli`, `forge` MCP tool, `ForgeCore` |
| Operations | `assess`, `checkpoint`, `verify`, `close` |

`node cli.js doctor` is read-only: it reports an uninitialized store without creating a token or host data.
