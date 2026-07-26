# Tether

> **TL;DR:** Tether stops coding agents from declaring success until important claims are backed by evidence & real checks.

Coding agents can sound certain even when they read an old file, misunderstood an API or skipped a
failing test. Tether gives them a local evidence ledger & signoff gate. Important claims must point
to evidence Tether can read, hash & invalidate when source changes.

During work, Tether records claims, evidence, decisions & executable checks. At signoff, it blocks
completion while critical claims remain unsupported or required checks still fail. It stores this
audit trail, never private chain-of-thought.

Enforcement hooks work **without MCP & without model cooperation**, so a model cannot talk its way
past a gate it does not run. An optional MCP server exposes `tether` (`assess`, `checkpoint`,
`verify`, `close`) plus `docs`.

## Why "tether"

A tether is a physical constraint that stops you drifting, and that is the mechanism:

- a claim is tethered to a **locator the core reads and hashes** — an excerpt you merely assert is
  recorded but counts for nothing;
- the **invalidation key is the tether breaking** — when the lockfile or the source hash moves, the
  evidence goes stale and anything resting on it needs re-checking;
- the **hooks are the anchor point** — they fire on tool failure and at signoff whether or not the
  model remembered any of this.

This is deliberately *not* a reflection tool. The research it is built on
([Huang et al., ICLR 2024](https://arxiv.org/abs/2310.01798)) found that a model reflecting on itself
without external grounding can get *worse*. Tether supplies the grounding rather than the
introspection.

> **Origin of the design:** the architecture came out of a research synthesis originally named
> REFLECT — *Recursive Evidence Framework for Learning, Execution, Context and Thought*. The seven
> mechanisms it names are all still here (bounded re-entry, evidence as the durable unit, layered
> framework, conditioned lessons, execution-backed checks, governed context, private thought); the
> product simply took the name of what it does. Full adjudication in
> [`TETHER-MASTER.md`](TETHER-MASTER.md).

## Run

```sh
npx @orthic-labs/tether
node cli.js assess --operator --json <<'JSON'
{"summary":"Fix the parser","task_kind":"bugfix","claims":[{"text":"The parser rejects escaped quotes","kind":"behavioral_fact","materiality":"critical"}]}
JSON
```

State lives in `.tether/` by default. Set `TETHER_STORE_ROOT` for CI or a shared location. Files
are owner-only, payloads are SHA-256 addressed, and interrupted JSONL writes do not invalidate
previous records. `TETHER_DOCS_OFFLINE=1` is the safe policy for environments where network access
must be impossible; the resolver already prefers the lockfile and installed package source.

Install the Claude Code fragment from `hooks/claude-code/settings.json`. Every adapter returns the
neutral `{action: allow|continue|block|noop}` contract; the hook does not execute user commands.

## v1 migration

`sequentialthinking`, `resolve-library-id`, and `query-docs` return explicit migration errors in v2.
Set `TETHER_LEGACY_TOOLS=1` only while migrating a v1 host; the old behavior remains regression-tested
but is not advertised by the v2 server.
