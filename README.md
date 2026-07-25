# REFLECT

**Recursive Evidence Framework for Learning, Execution, Context and Thought**

REFLECT is a local evidence-and-gate core for agents. It records claims, evidence, decisions, and
checks; it never persists private chain-of-thought. The enforcement hooks work without MCP or model
cooperation, while the optional MCP server exposes two tools: `reflect` (`assess`, `checkpoint`,
`verify`, `close`) and `docs`.

The name is the architecture:

| Letter | Element | In the system |
|---|---|---|
| **R**ecursive | bounded re-entry | checkpoints and gates re-enter on failure, under hard retry budgets — never an open loop |
| **E**vidence | the durable unit | typed, hashed, locator-bearing records with invalidation keys |
| **F**ramework | layers, not a prompt | enforcement hooks · guidance skill · state-and-docs core |
| **L**earning | conditioned lessons | failure diagnosis and quarantined memory candidates, never auto-promoted |
| **E**xecution | checks outrank opinion | deterministic test/build/typecheck results with a non-model executor |
| **C**ontext | governed, not hoarded | compact state diffs; full payloads dereferenced on demand |
| **T**hought | private and transient | native model reasoning stays the model's own; only decisions persist |

## Run

```sh
npx @damned-designs/reflect
node cli.js assess --operator --json <<'JSON'
{"summary":"Fix the parser","task_kind":"bugfix","claims":[{"text":"The parser rejects escaped quotes","kind":"behavioral_fact","materiality":"critical"}]}
JSON
```

State lives in `.reflect/` by default. Set `REFLECT_STORE_ROOT` for CI or a shared location. Files
are owner-only, payloads are SHA-256 addressed, and interrupted JSONL writes do not invalidate
previous records. `REFLECT_DOCS_OFFLINE=1` is the safe policy for environments where network access
must be impossible; the resolver already prefers the lockfile and installed package source.

Install the Claude Code fragment from `hooks/claude-code/settings.json`. Every adapter returns the
neutral `{action: allow|continue|block|noop}` contract; the hook does not execute user commands.

## v1 migration

`sequentialthinking`, `resolve-library-id`, and `query-docs` return explicit migration errors in v2.
Set `REFLECT_LEGACY_TOOLS=1` only while migrating a v1 host; the old behavior remains regression-tested
but is not advertised by the v2 server.
