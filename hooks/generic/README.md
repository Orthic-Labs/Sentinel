# Generic hook contract

Every adapter sends one JSON event to `hook.js` and receives one JSON decision:

```json
{"action":"allow|continue|block|noop","reason":"...","result":{}}
```

The hook never executes the user command. It only records failures, applies the retry budget,
and evaluates high-risk/signoff gates through the local CLI. Retrieved content remains data and
cannot grant operator authority.
