# Ricky Bitcoin Mining Control Center v7

A local browser-based SHA-256d hashing measurement dashboard with persistent record history.

## Start on Mac

1. Clone or download the repository.
2. Open Terminal in the project folder.
3. Run:

```bash
chmod +x start.command tests/run_tests.sh
./start.command
```

The dashboard opens at `http://127.0.0.1:8791/?version=v7`.

## Measurement scopes

| Scope | Reset rule |
|---|---|
| Current second | Starts a new bucket each second |
| Current network block | Resets when `/api/network` reports a changed Bitcoin tip hash or height |
| Current session | Resets only when **Reset session** is pressed |
| Lifetime | Persists in browser `localStorage` until records are explicitly cleared |

A session reset does not erase the current-block counter or lifetime records. A new Bitcoin tip resets current-block statistics but does not erase session or lifetime history.

## Record-breaking hash history

Each new record stores the exact timestamp, full hash and difficulty, previous record, improvement multiplier, network snapshot, percentage of the displayed network target, session/lifetime/current-block counts, local job and nonce details, outcome status, hashrate, and runtime.

Old v7 records are migrated when possible. Fields never captured by earlier versions remain unavailable rather than being invented. CSV export contains the complete stored schema.

## Important eligibility boundary

This repository performs real double-SHA-256 calculations on synthetic local 80-byte headers. It is a hashing measurement dashboard, not a complete Bitcoin solo miner. It does not obtain a valid block template, connect to Stratum, submit shares, or submit a valid block.

Saved records therefore truthfully use `submitted = false`, `shareAccepted = false`, `blockCandidate = false`, and `blockCandidateStatus = ineligible-synthetic-work`. Even a synthetic result above the displayed target would not qualify for a Bitcoin reward.

## Tests

```bash
chmod +x tests/run_tests.sh
tests/run_tests.sh
```

The suite checks JavaScript syntax, SHA-256 vectors, record schema/migration, current-block reset behavior, Python syntax, and local-server delivery.

## Collaboration

Read `COLLABORATION_HANDOFF.md` before editing. Use a narrow branch, declare file ownership, compare with latest `main`, and run the full test suite before integration.
