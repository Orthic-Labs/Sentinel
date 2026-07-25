# Codex adapter

Codex hosts should translate their current hook events to the neutral generic contract and invoke:

```text
node hooks/generic/hook.js
```

Keep the translation in the host adapter. The shared hook intentionally does not assume a Codex
event field that can drift between host releases.
