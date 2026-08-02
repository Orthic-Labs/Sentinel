# Historical store migration — completed 2026-08-02

This dated migration record has no live compatibility path. Current Sentinel accepts no legacy bin, MCP tool, class, environment, store-root, or bearer-token alias.

## Current contract

| Surface | Canonical contract |
|---|---|
| Host data | `~/Library/Application Support/sentinel/` on macOS, with `SENTINEL_HOST_DATA` only for host-controlled test or integration environments |
| Store | `<host-data>/stores/<project-hash>/`; never a repository-local default |
| Trusted authority | `--host-stdio` with a verified Developer-ID-signed CodeRight parent; shell invocations always receive model authority |
| CLI / MCP / core | `sentinel`, `sentinel-cli`, `sentinel` MCP tool, `SentinelCore` |
| Operations | `assess`, `checkpoint`, `verify`, `close` |

`node cli.js doctor` is read-only: it reports an uninitialized store without creating a token or host data.
