# Codex adapter

`.codex-plugin/plugin.json` installs lifecycle hooks. `hooks/codex/hook.js` translates neutral
Sentinel decisions into Codex hook output, using `CODEX_SESSION_ID` when event JSON lacks a session id.

Hook commands prefer `CODEX_PLUGIN_ROOT`, with `CLAUDE_PLUGIN_ROOT` as a compatibility fallback
(Codex previously inherited the Claude variable name).
