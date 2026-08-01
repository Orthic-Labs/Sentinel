# Store / token migration — Tether → Beacon

Beacon v2.0.1 keeps **dual aliases** (`beacon` / `tether`, `BEACON_*` / `TETHER_*`) during the rename.

## Host data directory

| Preference | macOS | Linux | Windows |
|---|---|---|---|
| New default | `~/Library/Application Support/beacon/` | `~/.local/share/beacon/` | `%LOCALAPPDATA%/beacon/` |
| Legacy (auto-used if present and beacon dir missing) | `.../tether/` | `.../tether/` | `.../tether/` |

Override: `BEACON_HOST_DATA` or `TETHER_HOST_DATA`.

## Project store

| Preference | Path |
|---|---|
| Host default | `<host-data>/stores/<project-hash>/` |
| Legacy repo | `<project>/.tether/` (or `.beacon/`) if it has `events.jsonl` and the host store does not |

Override: `BEACON_STORE_ROOT` or `TETHER_STORE_ROOT`.

`<project-hash>` = first 16 hex chars of SHA-256 of the absolute project root.

## Host trust token

| File | Purpose |
|---|---|
| `<host-data>/host.token` | Shared secret for `--hook` / `--operator` |

Hooks create the token on first run (`0600`). Manual init:

```sh
node cli.js init
# aliases: host-init, tether-cli host-init
```

Trusted CLI must pass `BEACON_HOST_TOKEN` or `TETHER_HOST_TOKEN` matching that file. `TETHER_TRUSTED_CALLER=hook` remains rejected.

## Manual migrate (optional)

```sh
PROJECT=/path/to/your/project
HASH=$(node -e "const crypto=require('crypto'),path=require('path');console.log(crypto.createHash('sha256').update(path.resolve(process.argv[1])).digest('hex').slice(0,16))" "$PROJECT")
# macOS example — use the beacon host dir once you are ready to leave legacy tether/
DEST="$HOME/Library/Application Support/beacon/stores/$HASH"
mkdir -p "$DEST"
# copy from either legacy repo store or old tether host store
cp -a "$PROJECT/.tether/." "$DEST/" 2>/dev/null || true
cp -a "$HOME/Library/Application Support/tether/stores/$HASH/." "$DEST/" 2>/dev/null || true
# token: copy once if moving host data roots
cp "$HOME/Library/Application Support/tether/host.token" \
   "$HOME/Library/Application Support/beacon/host.token" 2>/dev/null || true
```

After verifying the new store, remove repo-local `.tether/` / `.beacon/` and keep them gitignored.

## Bins / MCP / ops

| Surface | Names |
|---|---|
| CLI / MCP server bins | `beacon`, `beacon-cli`, `tether`, `tether-cli` |
| Core class | `BeaconCore` (`ReflectCore` alias) |
| MCP tools | `beacon` + `tether` (same schema) |
| Ops | still `assess` / `checkpoint` / `verify` / `close` |

## Doctor

```sh
node cli.js doctor
```

Checks host token, store writability, Node ≥20, and plugin-root env hints (`CODEX_PLUGIN_ROOT` preferred over `CLAUDE_PLUGIN_ROOT`).
