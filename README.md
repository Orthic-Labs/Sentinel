<img src=".github/banner.svg" alt="Sentinel — Claims need evidence. Checks must pass." width="100%">

**Sentinel stops AI agents from signing off on source guesses or skipped tests: material claims need source-backed evidence, and required checks must pass before work can close.**

[![License](https://img.shields.io/badge/license-source--available?style=flat-square&labelColor=111318&color=5362d8)](LICENSE)
[![Ledger](https://img.shields.io/badge/ledger-local--first?style=flat-square&labelColor=111318&color=5362d8)](#local-ledger)
[![Interfaces](https://img.shields.io/badge/interfaces-CLI%20%2B%20MCP?style=flat-square&labelColor=111318&color=5362d8)](#quick-start)

## What it is

The public repo is Sentinel. The CLI package and MCP tool keep the name `tether`, which remains the compatibility alias for every command and tool id shown below.

Coding agents can sound certain after reading stale code, guessing an API, or skipping a failed test. Sentinel adds a local evidence ledger plus enforcement gates, turning "I think this is correct" into a proof trail: claim, source hash, check result, and the policy that allowed signoff.

It stores structured work state, not private chain-of-thought.

## How it works

```text
assess task
    │
    ├── declare material claims + acceptance criteria
    ▼
checkpoint after evidence, failure or decision
    │
    ├── attach source-backed evidence
    ├── record executable checks
    └── invalidate facts whose source changed
    ▼
verify / close
    │
    ├── pass: required evidence + checks exist
    └── block: open critical claim or missing/failed proof
```

Four operations share one core:

| Operation | Purpose |
|---|---|
| `assess` | open a run, classify the task, define claims and acceptance criteria |
| `checkpoint` | record evidence, decisions, failures, checks, and claim updates |
| `verify` | evaluate the current ledger against task policy or a high-risk gate |
| `close` | sign off only when required proof is complete |

The CLI is the primary transport for hooks and automation. An optional MCP server exposes `tether` plus `docs` for model-initiated use.

## Evidence model

A repo claim counts only when Sentinel itself reads the locator and hashes its content. A model-supplied excerpt can be stored for context, but it does not satisfy repository-evidence policy by assertion alone.

Evidence records carry: kind and trust class, locator, SHA-256 payload hash, retrieval time, linked claim IDs, invalidation key, and a bounded excerpt or stored payload reference.

Claim states are explicit: open, supported, refuted, stale, or waived. Material or critical claims left open block signoff.

Evidence trust follows source:

```text
deterministic execution
  > live local state
  > installed dependency source
  > official versioned docs
  > primary current source
  > independent verifier
  > model assertion
```

Model assertions never satisfy external-proof minimums.

Evidence stays useful only while the source it describes stays the same. Sentinel binds proof to event keys: file content hash, lockfile or dependency version, worktree state, current external revision or expiry, check input fingerprint. When a key changes, linked evidence goes stale and dependent claims need rechecking. Exact-version facts use lockfile or source invalidation instead of arbitrary time decay.

## Local ledger

The default store lives outside the project tree, in the host data directory (see `docs/store-migration.md`). A legacy repo-local `.tether/` is still read when present and not yet migrated.

```text
~/Library/Application Support/tether/stores/<project-hash>/   # macOS default
├── events.jsonl
└── objects/
    └── sha256/<prefix>/<digest>
```

Directory permissions are owner-only; event and object files use mode `0600`. Payloads are SHA-256 addressed and deduplicated, written to a temporary file, then renamed atomically. JSONL appends preserve earlier valid events if the process is interrupted. Override the path with `TETHER_STORE_ROOT`, or migrate from `.tether/` per `docs/store-migration.md`.

Run responses return state diffs such as claim updates, next actions, unresolved items, and context references, instead of replaying the full history into the model's context.

## Enforcement

Sentinel's strongest property is enforcement outside the model. Host adapters can invoke the same core on tool failure, a blind identical retry, a risky command, signoff or stop, and generic CI or runner boundaries. This works without MCP and without the model remembering the protocol. Every adapter returns a neutral `{action: allow|continue|block|noop}` contract and never executes the user's command itself.

Retry budgets fingerprint a failed action. Repeating the same unchanged attempt can be blocked, while a meaningfully changed attempt gets a new fingerprint.

Default policies vary by task kind:

| Task | Minimum proof |
|---|---|
| docs | trusted docs/log/test evidence + passing check |
| refactor | attested repo evidence + passing check |
| bugfix / feature | attested repo evidence + trusted docs/log/test evidence + passing check |
| release | same evidence classes + two passing checks |

The high-risk gate also requires explicit intent, blast radius, and a safety case. Checks count only when the executor is not `model_claim`. Acceptance criteria can require particular evidence kinds. Close is idempotent when the ledger hash hasn't changed; later work opens a superseding run.

## Version-aware docs

`docs` resolves the dependency version from project lockfiles, then searches installed package source before remote documentation. Results are hashed, bounded, labeled untrusted, and scanned/redacted for injection-shaped content.

Set `TETHER_DOCS_OFFLINE=1` to forbid network access. This makes version-sensitive API research reproducible instead of silently answering from latest documentation.

## What makes it different

Sentinel isn't a "think harder" prompt or a reflection diary. Its advantage:

- core-read attestation: source counts only after the core reads and hashes it
- dependency-aware invalidation: proof breaks when source, lockfile, or input changes
- model-independent gates: hooks enforce policy even when the model skips a tool
- typed uncertainty: unsupported, refuted, and stale are data states, not writing style
- external-signal requirement: executable checks outrank self-reported confidence
- content-addressed audit trail: compact, local, and tamper-evident by hash
- bounded state diffs: rigor doesn't require replaying the full work log
- one core across CLI, MCP, hooks, and CI: no separate truth per integration

Sentinel's moat is enforcement coupled to verifiable evidence, not another instruction asking the model to be careful.

## Quick start

```sh
npx @orthic-labs/tether

node cli.js assess --operator --json <<'JSON'
{"summary":"Fix parser","task_kind":"bugfix","claims":[{"text":"Parser rejects escaped quotes","kind":"behavioral_fact","materiality":"critical"}]}
JSON
```

Optional MCP tools:

```text
tether(operation: assess | checkpoint | verify | close)
docs(library, topic, version?, project_root?)
```

## Trust & privacy

- No private chain-of-thought persistence.
- Retrieved content is framed as untrusted evidence.
- Hooks read a host token from the application data directory; `TETHER_TRUSTED_CALLER` is retired (see `docs/store-migration.md`).
- The store is local and owner-only by default.
- Network documentation can be disabled completely.
- Hooks never execute a supplied command.
- Budget ceilings bound evidence items, verifier calls, external requests, and return size.

## Status

Sentinel v2 ships claims, evidence, decisions, checks, invalidation, retry budgets, task policies, version-aware docs, CLI, MCP, and host hooks.

Current limits:

- it proves the supplied acceptance policy, not the absence of every possible bug
- external/current facts still depend on an available authoritative source
- the host must install the appropriate hook adapter for model-independent enforcement
- deprecated v1 tools return migration errors unless `TETHER_LEGACY_TOOLS=1` is set temporarily

Full design history and adjudication: [`TETHER-MASTER.md`](TETHER-MASTER.md). Integration coverage: [`docs/integration-matrix.md`](docs/integration-matrix.md).

## License

Source-available proprietary software for internal use and evaluation; redistribution, repackaging, and competing use are prohibited. See [LICENSE](LICENSE). Prior MIT grants remain documented in [LICENSE-MIT-LEGACY](LICENSE-MIT-LEGACY).

<!-- blueprint:docs:start -->
## Repository truth docs
- [Product overview](docs/product.md) — what this is and does (generated, code-grounded)
- [Architecture](docs/architecture.md) — components, flows, interfaces (generated, code-grounded)
<!-- blueprint:docs:end -->

---

<sub><b><a href="https://orthic-labs.github.io">Orthic Labs</a></b> — local-first infrastructure for AI-assisted development.<br>
<a href="https://github.com/Orthic-Labs/Membrane">Membrane</a> · <a href="https://github.com/Orthic-Labs/Cortex">Cortex</a> · <a href="https://github.com/Orthic-Labs/Sentinel">Sentinel</a> · <a href="https://github.com/Orthic-Labs/Roundtable">Roundtable</a> · <a href="https://github.com/Orthic-Labs/Morph">Morph</a> · <a href="https://github.com/Orthic-Labs/CutRight">CutRight</a> · <a href="https://github.com/Orthic-Labs/claudecodeX">claudecodeX</a></sub>
