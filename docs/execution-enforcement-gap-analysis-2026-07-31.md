# Execution Enforcement Gap Analysis

Date: 2026-07-31  
Systems: Tether v2, `tasklist`, `brief`, Codex Desktop, HeardRight 0.1.76

## Verdict

Instructions were present but enforcement was incomplete. `brief` constrained response shape,
`tasklist` could validate a durable route when explicitly invoked, and Tether could validate an
active evidence ledger. Nothing bound the user's exact requested validation method to each tool
action and final claim.

The missing component is a semantic execution controller:

```text
user request
  -> exact execution contract
  -> route/action lock
  -> criterion-bound checks
  -> evidence-bound final claims
```

## Incident Outcome

Product fix and release succeeded:

- Source fix commit: `594d1d0a`.
- Release commit: `8013bce4`.
- Windows 0.1.76 signed, hardened, uploaded and registered on patch channel.
- Exact replay eventually ran with Windows DirectML, production 50 ms cadence and current
  classifier.
- Five preserved recordings passed: Edge twice, Calculator, Chrome and Screenshot.
- Final probe decode latency was 114-135 ms; prior 1.1-second per-probe Start Apps scan was absent.

Process execution failed repeatedly before that proof was obtained.

## Agent Failures

### 1. False equivalence between test classes

The initial signoff treated classifier unit tests, release gates and successful packaging as if they
also proved replay behavior on saved recordings. They do not.

Required distinction:

| Claim | Required evidence |
|---|---|
| Classifier logic passes | Focused unit test |
| Release is valid | Build, signing, hardening and upload receipts |
| Prior recordings fire immediately | Exact audio replay through production-equivalent runtime |

### 2. Unsupported completion language

The response implied the runtime behavior was verified before audio replay occurred. The correct
status was: committed and released; recording replay not yet run.

### 3. Acceptance method was not frozen

User requested the last 5-10 command recordings through the new runtime fix. Execution changed
between:

- full 50 ms replay;
- CPU substitution;
- reduced 1,750 ms cadence;
- transcript-only reasoning;
- attempts to infer behavior from unit tests.

Only Windows DirectML, production cadence and saved WAVs satisfied the request.

### 4. Existing runtime prerequisite was missed

Standalone replay was launched without `ORT_DYLIB_PATH`. Process remained near 5 MB and slept
before model allocation. This was initially misread as compilation time and later as DirectML
contention.

Correct prerequisite:

```powershell
$env:ORT_DYLIB_PATH = 'D:\Claude\heardright\tauri-app-next\src-tauri\resources\runtime\onnxruntime.dll'
$env:HR_ASR_EP = 'dml'
```

Once configured, exact five-clip replay completed in 17.7 seconds.

### 5. No no-progress watchdog

Idle replay attempts continued for more than nine minutes despite negligible CPU and memory. A
60-second no-progress boundary would have exposed missing runtime initialization immediately.

### 6. Method substitution after failure

Instead of diagnosing the frozen process first, execution changed provider and cadence. This
violated user intent and destroyed comparability.

### 7. Unnecessary application disruption

HeardRight was stopped based on an unproven DirectML-contention hypothesis. Missing ORT setup—not
the live app—was the actual cause. App was later restarted.

### 8. Poor status precision

Updates described replay as compiling or processing when process telemetry showed it was idle
before model load. Status language exceeded available evidence.

### 9. User corrections did not reset execution route

Repeated corrections should have invalidated every substituted route and restored the original
acceptance method. This happened only after several failed attempts.

## Existing System Gaps

### `brief`

`brief` contains the correct minimal implementation ladder and continuation rule, but it is a prompt
policy. It cannot block a tool call, terminate a stalled process or reject an unsupported claim.

### `tasklist`

`tasklist` can freeze State A, State B, checks, expected results and evidence paths. Its validator
checks artifact structure and receipt freshness. It does not:

- activate automatically for a material multi-step task;
- bind tool calls to the selected route;
- reject an unlisted validation method;
- observe command execution;
- inspect final response claims.

Its semantic-correction contract is correct but depends on agent invocation.

### Tether activation

Tether enforcement requires an active run or session binding. Current generic hook explicitly
returns `noop` for routine tool use without an active run. No Tether events were recorded for this
incident, proving Codex Desktop did not bind this task to an active run.

Relevant code:

- `hooks/generic/hook.js`: no active run permits routine commands.
- `hooks/codex/hooks.json`: declares lifecycle hooks, but current host path did not deliver this
  session into ledger.
- `docs/integration-matrix.md`: Codex adapter is described as translation, not verified end-to-end
  enforcement.

### Tether check relevance

Current PostToolUse logic records every successful tool call as:

```text
<tool> completed successfully
```

`lib/verify.js` counts trusted passing checks by authority and status. It does not require a passing
check to match a specific acceptance criterion's `verification` field. Therefore an unrelated Cargo
unit test can satisfy generic passing-check count while audio replay remains undone.

### Tether rubric enforcement

Rubrics store:

- criterion text;
- severity;
- verification list;
- required evidence kinds.

Gate evaluation does not calculate criterion-by-criterion coverage. Acceptance criteria can exist
without their declared verification being executed.

### Tether action semantics

PreToolUse enforcement currently checks a narrow destructive-command regex. It does not compare a
proposed command against:

- selected task or route step;
- approved test command;
- provider;
- fixture set;
- cadence;
- expected duration;
- allowed scope.

### Tether retry semantics

Blind identical failures can be budgeted, but semantically equivalent failed attempts with changed
commands receive different fingerprints. Method drift therefore bypasses retry protection.

### Tether fail-open behavior

Adapter evaluation exceptions default to `noop`. This is appropriate for low-risk telemetry but not
for signoff or a required validation gate. An unavailable enforcement system can silently permit
completion.

### Final-answer enforcement

Repository gates do not inspect assistant response text. Current Stop verification checks ledger
minimums, not whether claims such as `tested`, `verified`, `instant` or `complete` are supported by a
matching criterion receipt.

## Required Fix

### P0. Add an execution-contract object

Every material task receives an immutable contract before first mutating or validating action:

```json
{
  "state_b": "Five latest relevant recordings pass current Windows runtime replay",
  "method": {
    "runner": "opening_command_cadence_replay",
    "provider": "dml",
    "cadence_ms": 50,
    "fixtures": ["recording-1.wav", "recording-2.wav"],
    "model_hash": "..."
  },
  "expected_max_ms": 60000,
  "proof": "criterion-specific replay receipt"
}
```

Bind contract hash to Tether run, GoalRoute/tasklist receipt and final evidence.

### P0. Require active Tether binding

For material tasks, first applicable tool call must have an active run. Host should create task-start
event or block with `tether_assess_required`. Do not infer acceptance criteria from shell text.

Codex Desktop needs an integration test proving these events reach Tether:

- PreToolUse;
- PostToolUse;
- PostToolUseFailure;
- Stop.

### P0. Enforce criterion-bound checks

Change `lib/verify.js` so every critical criterion must have:

1. matching verification fingerprint;
2. trusted executor;
3. exit code zero;
4. current workspace/input hash;
5. required evidence kinds.

Generic count thresholds may remain as secondary policy. They must never substitute for criterion
coverage.

### P0. Add method and route lock

PreToolUse must compare proposed action against current Tasklist/GoalRoute step and execution
contract. Block changes to provider, cadence, fixtures, runner or scope unless route is explicitly
recompiled after user correction or new evidence.

Expected decision:

```json
{
  "action": "block",
  "code": "execution_contract_drift",
  "expected": "dml / 50 ms / saved WAVs",
  "observed": "cpu / 1750 ms / saved WAVs"
}
```

### P0. Add no-progress watchdog

Long-running commands must run through an owned process wrapper with:

- expected duration;
- progress heartbeat;
- 60-second unexpected-silence threshold;
- exact launched-process-tree termination;
- captured CPU, memory and last output;
- automatic Tether failure checkpoint;
- prohibition on method substitution until failure is diagnosed.

Known long builds may declare a larger heartbeat interval in execution contract.

### P0. Add final-claim gate

Host must submit structured final claims before response release:

```json
{
  "claims": [
    {
      "text": "Five recordings passed exact Windows runtime replay",
      "criterion_id": "opening-replay",
      "receipt_id": "..."
    }
  ]
}
```

Block final response when:

- claim has no criterion;
- receipt is missing;
- receipt method differs;
- receipt predates current commit/input hash;
- only weaker evidence class exists.

### P1. Make PostToolUse relevance-aware

Do not automatically count every successful tool invocation as a check. Classify results as:

- `observation`;
- `diagnostic`;
- `criterion_check`;
- `mutation`;
- `release_artifact`.

Only `criterion_check` with matching contract fingerprint can advance acceptance.

### P1. Make semantic retry fingerprints stable

Fingerprint requested outcome and method dimensions, not raw command only. CPU and altered-cadence
replays should be recognized as method drift from the DML/50 ms criterion, not fresh valid attempts.

### P1. Fail closed at required boundaries

- PreToolUse for high-risk or contract-locked action: fail closed.
- Stop/signoff: fail closed.
- PostToolUse telemetry: may fail open but marks run enforcement-degraded.
- A degraded run cannot sign off.

### P1. Add one canonical HeardRight replay command

Provide one supported command:

```powershell
pnpm test:opening-replay -- --last 5 --provider dml --cadence 50
```

Runner must:

1. resolve exact relevant owner-diagnostic WAVs;
2. set production `ORT_DYLIB_PATH`;
3. verify production model hashes;
4. use Windows DirectML and current classifier;
5. preserve/restart HeardRight only if exclusivity is proven necessary;
6. emit per-clip transcript, classification, fire-audio time and decode latency;
7. write signed or content-addressed receipt bound to Git tree and fixture hashes;
8. finish within declared timeout or emit diagnostic failure.

### P2. Connect `tasklist` and Tether

Tasklist receipt should export selected route steps and exact checks into Tether. Tether should reject
actions not mapped to current step. Task completion should require Tether criterion receipt, not a
Markdown status edit alone.

One-step deterministic work does not need a full Tasklist artifact, but still needs a compact
execution contract when completion claim depends on external/runtime evidence.

### P2. Keep `brief` presentation-only

Do not add more enforcement prose to `brief`. Its role is concise communication. Execution safety
belongs in Tether, host hooks and owned runners.

## Required Tests

1. Material tool use without active run is blocked.
2. Unrelated successful command does not satisfy acceptance criterion.
3. Criterion verification with wrong provider is blocked.
4. Criterion verification with altered cadence is blocked.
5. Criterion verification with different fixtures is blocked.
6. No-progress timeout terminates only launched process tree and records diagnostics.
7. User correction invalidates downstream route and forces global recompile.
8. Stop gate rejects `tested` claim without exact receipt.
9. Stop gate rejects stale receipt after Git tree or fixture hash changes.
10. Codex Desktop lifecycle events appear in Tether ledger during integration test.
11. Exact HeardRight replay command passes five preserved command recordings within 60 seconds.

## Acceptance State

System is fixed only when this sequence is impossible:

1. user requests exact runtime replay;
2. agent runs unit tests or alternate provider;
3. unrelated passing check satisfies gate;
4. agent claims runtime behavior verified.

Required invariant:

```text
requested criterion
  == selected route step
  == executed method fingerprint
  == evidence receipt
  == final claim
```
