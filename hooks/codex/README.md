# Codex adapter

`.codex-plugin/plugin.json` installs lifecycle hooks. `hooks/codex/hook.js` translates neutral
Tether decisions into Codex hook output, using `CODEX_SESSION_ID` when event JSON lacks a session id.
