# Blueprint orientation evidence — hook point

Forge accepts Blueprint orientation receipts when present; it does not require Blueprint to ship first.

## Accepted evidence shapes

| Field | Meaning |
|---|---|
| `kind` | `blueprint_orientation`, `blueprint`, or `orientation` |
| `blueprint_receipt` / `receipt` | Opaque receipt id from Blueprint P1 |
| `orientation_hash` | Optional content hash of the orientation payload |
| `excerpt` | Bounded human-readable summary |

## Trust derivation

- **hook / operator** authority with a receipt → attested `tool` trust (`blueprint_orientation: true`).
- **model** authority with a receipt → accepted as orientation marker; still issuer-capped (prefer host re-record for gate minima).
- Incomplete orientation (kind only, no receipt/excerpt) → not accepted.

## Gate use

Orientation evidence counts toward docs-like minima when `kind` is a Blueprint kind and `trust_class` is trusted. Criteria may also require `required_evidence_kinds: ['blueprint']`.

## Integration sketch

```js
core.checkpoint({
  run_id,
  evidence: [{
    kind: 'blueprint_orientation',
    blueprint_receipt: orientation.receipt_id,
    excerpt: orientation.summary,
    claim_ids: [claimId],
  }],
}, 'hook');
```

When Blueprint P1 emits a stable receipt schema, map it here without changing Forge ops (`assess` / `checkpoint` / `verify` / `close`).
