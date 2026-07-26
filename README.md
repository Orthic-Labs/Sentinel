# Tether

> **TL;DR:** Tether stops AI agents signing off on source guesses or skipped tests: important claims need source-backed evidence & required checks must pass before work can close.

Coding agents can sound certain after reading stale code, guessing an API or skipping a failed test.
Tether adds a local evidence ledger plus enforcement gates, turning “I think this is correct” into a
proof trail: claim, source hash, check result & policy that allowed signoff.

It stores structured work state—not private chain-of-thought.

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
| `assess` | open run, classify task, define claims & acceptance criteria |
| `checkpoint` | record evidence, decisions, failures, checks & claim updates |
| `verify` | evaluate current ledger against task policy or high-risk gate |
| `close` | sign off only when required proof is complete |

CLI is primary transport for hooks & automation. Optional MCP server exposes `tether` plus `docs`
for model-initiated use.

## Evidence, not evidence-shaped prose

A repo claim counts only when Tether itself can read locator & hash its content. An excerpt supplied
by model can be stored for context, but it cannot satisfy repository-evidence policy by assertion.

Evidence records can carry:

- kind & trust class;
- locator;
- SHA-256 payload/content hash;
- retrieval time;
- linked claim IDs;
- invalidation key;
- bounded excerpt or stored payload reference.

Claim states are explicit: open, supported, refuted, stale or waived. Material/critical claims left
open block signoff.

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

## Invalidation

Evidence remains useful only while source it describes remains same. Tether binds proof to event
keys such as:

- file content hash;
- lockfile/dependency version;
- worktree state;
- current external revision/expiry;
- check input fingerprint.

When key changes, linked evidence becomes stale & dependent claims must be rechecked. Exact-version
facts use lockfile/source invalidation rather than arbitrary time decay.

## Local content-addressed ledger

State lives under `.tether/` by default:

```text
.tether/
├── events.jsonl
└── objects/
    └── sha256/<prefix>/<digest>
```

- directory permissions are owner-only;
- event/object files use mode `0600`;
- payloads are SHA-256 addressed & deduplicated;
- objects are written to temporary file then atomically renamed;
- JSONL appends preserve earlier valid events if process is interrupted;
- state can move to CI/shared location through `TETHER_STORE_ROOT`.

Run responses return state diffs—claim updates, next actions, unresolved items & context
references—instead of replaying entire history into model context.

## Model-independent enforcement

Tether’s strongest property is enforcement outside model.

Host adapters can invoke same core on:

- tool failure;
- blind identical retry;
- risky command;
- signoff/stop;
- generic CI or runner boundaries.

This works without MCP & without model remembering protocol. Every adapter returns neutral
`{action: allow|continue|block|noop}` contract & never executes user command itself.

Retry budgets fingerprint failed action. Repeating same unchanged attempt can be blocked while a
meaningfully changed attempt receives new fingerprint.

## Policy gates

Default policies vary by task kind:

| Task | Minimum proof |
|---|---|
| docs | trusted docs/log/test evidence + passing check |
| refactor | attested repo evidence + passing check |
| bugfix / feature | attested repo evidence + trusted docs/log/test evidence + passing check |
| release | same evidence classes + two passing checks |

High-risk gate also requires explicit intent, blast radius & safety case.

Checks count only when executor is not `model_claim`. Acceptance criteria can require particular
evidence kinds. Close is idempotent when ledger hash has not changed; later work opens superseding
run.

## Version-aware docs

`docs` resolves dependency version from project lockfiles, then searches installed package source
before remote documentation. Results are hashed, bounded, labeled untrusted & scanned/redacted for
injection-shaped content.

Set `TETHER_DOCS_OFFLINE=1` to forbid network access. This makes version-sensitive API research
reproducible instead of silently answering from latest documentation.

## What makes it different

Tether is not a “think harder” prompt or reflection diary. Its concrete advantage comes from:

- **core-read attestation:** source counts only after core reads & hashes it;
- **dependency-aware invalidation:** proof breaks when source/lockfile/input changes;
- **model-independent gates:** hooks enforce policy even when model skips tool;
- **typed uncertainty:** unsupported/refuted/stale are data states, not writing style;
- **external-signal requirement:** executable checks outrank self-reported confidence;
- **content-addressed audit trail:** compact, local & tamper-evident by hash;
- **bounded state diffs:** rigor does not require replaying full work log;
- **same core across CLI, MCP, hooks & CI:** no separate truth per integration.

Tether’s moat is enforcement coupled to verifiable evidence—not another instruction asking model to
be careful.

## Run

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
- Arbitrary client strings cannot expand supported protocol.
- Store is local & owner-only by default.
- Network documentation can be disabled completely.
- Hooks never execute supplied commands.
- Budget ceilings bound evidence items, verifier calls, external requests & return size.

## Current scope

Tether v2 ships claims, evidence, decisions, checks, invalidation, retry budgets, task policies,
version-aware docs, CLI, MCP & host hooks.

Current limits:

- it proves supplied acceptance policy, not absence of every possible bug;
- external/current facts still depend on available authoritative source;
- host must install appropriate hook adapter for model-independent enforcement;
- deprecated v1 tools return migration errors unless `TETHER_LEGACY_TOOLS=1` is set temporarily.

Full design history & adjudication: [`TETHER-MASTER.md`](TETHER-MASTER.md).
Integration coverage: [`docs/integration-matrix.md`](docs/integration-matrix.md).

## License

Source-available proprietary software for internal use & evaluation; redistribution, repackaging & competing use are prohibited. See [LICENSE](LICENSE). Prior MIT grants remain documented in [LICENSE-MIT-LEGACY](LICENSE-MIT-LEGACY).
