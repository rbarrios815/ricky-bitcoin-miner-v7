# Multi-chatbot handoff: Ricky Bitcoin Mining Control Center v7

## Source of truth

Canonical repository: `rbarrios815/ricky-bitcoin-miner-v7`, branch `main`.

Do not place this code in `rbarrios815/Bitcoin-Dashboard`; that is the separate basket-of-goods index. Before editing, inspect recent commits and open PRs, declare a narrow file lane, and work on a feature branch.

## Product boundary

v7 performs real double-SHA-256 calculations on synthetic local 80-byte headers. It is a hashing measurement dashboard, not a complete Bitcoin solo miner. It does not obtain a valid Bitcoin block template, build a coinbase/Merkle root, connect to Stratum, submit shares, or submit blocks.

Never describe synthetic work as accepted or reward-eligible. Records must remain:

- `submitted = false`
- `shareAccepted = false`
- `blockCandidate = false`
- `blockCandidateStatus = ineligible-synthetic-work`

`meetsNetworkDifficulty` is only a numerical comparison against the displayed reference.

## Reset scopes

| Scope | Reset behavior |
|---|---|
| Current second | New bucket each second |
| Current network block | Reset when observed tip hash or height changes |
| Current session | Reset by **Reset session** |
| Lifetime | Persist until explicitly cleared |

A new tip must not erase session or lifetime history. Session reset must not erase current-tip or lifetime history.

## Record schema

`record-utils.js` owns schema construction, legacy migration, target math, and block-scope reconciliation. Records include timestamp, full hash/difficulty, previous record, improvement multiplier, network difficulty/height/tip, target percentage, session/lifetime/current-block counts, session/local-job/worker/nonce metadata, submission outcome, hashrate, and runtime. Unknown legacy fields remain null.

## File ownership

| File | Responsibility |
|---|---|
| `index.html` | UI and labels |
| `record-utils.js` | Record schema and reset helpers |
| `app.js` | State, persistence, aggregation, record creation |
| `app-render.js` | Rendering |
| `app-runtime.js` | Controls, CSV, network polling, chart, startup |
| `miner-worker.js` | Synthetic work and in-batch record candidates |
| `server.py` | Loopback server and network proxy |
| `tests/` | Automated checks |

Keep the server bound to `127.0.0.1`.

## Known limitations

- A batch crossing a second boundary is assigned to the second in which it began.
- Median display is a 53-bit ordering prefix, not an exact 256-bit median hash.
- Concurrent worker message order defines dashboard record order; exact physical CPU-core ordering is not guaranteed.
- Record counts are exact within a received batch and deterministic in dashboard processing order.
- Browser-local storage varies by origin/profile and can be erased by browser data clearing.
- Network tip detection is best-effort and can be delayed while offline.

## Integration checklist

1. Compare against latest `main` and open PRs.
2. Run `tests/run_tests.sh`.
3. Verify Start, Pause/Resume, session reset, current-tip reset, reload persistence, full record fields, truthful not-submitted status, CSV export, and offline behavior.
4. Report changed files, tests, limitations, commit/PR, and next owner.
