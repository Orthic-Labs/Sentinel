# Claude Code adapter

Merge `settings.json` into the project settings after installing Reflect. Claude Code supplies
the hook event JSON on stdin; `hook.js` applies the deterministic filtering and returns the neutral
allow/continue/block/noop contract. The Stop handler honors `stop_hook_active` to prevent loops.
