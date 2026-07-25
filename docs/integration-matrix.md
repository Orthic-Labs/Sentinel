# Integration matrix

| Host | Adapter | Enforcement surface |
|---|---|---|
| Claude Code | `hooks/claude-code/settings.json` | PostToolUseFailure, PreToolUse risk matcher, Stop gate |
| Codex | `hooks/codex/README.md` | Translate current host events to neutral JSON |
| Generic MCP host | `server.js` | `reflect` and `docs` tools |
| CI | `cli.js` | `verify --gate signoff` exit code |

The host adapter owns event-field translation. The shared hook owns policy and does not execute
commands or accept model authority for waivers.
