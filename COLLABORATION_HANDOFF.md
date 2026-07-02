# Multi-chatbot handoff: Ricky Bitcoin Mining Control Center v7

## Source-of-truth status

The canonical source for **v7** is the standalone GitHub repository `rbarrios815/ricky-bitcoin-miner-v7`, branch `main`.

This app was rebuilt as a standalone local project because the earlier v6 source was not available in the connected GitHub repositories or workspace.

Do **not** place this code inside `rbarrios815/Bitcoin-Dashboard`. That repository is the separate Bitcoin basket-of-goods purchasing-power index and its README explicitly says it does not mine Bitcoin.

Before editing, pull the latest `main`, declare the files you own, and use a separate branch for changes unless Ricky explicitly directs otherwise.

## What v7 actually does

v7 performs real double-SHA-256 calculations in browser Web Workers and measures the resulting hashes. It provides:

- current hashrate and session hash count;
- best, median-prefix, and worst hash for the active one-second bucket;
- persistent best and worst hashes;
- record-beating best-hash history;
- CSV export;
- a logarithmic record-difficulty chart;
- best-effort Bitcoin network difficulty retrieval from the local Python server.

## Critical product boundary

This is a **hashing measurement dashboard**, not a complete Bitcoin solo miner.

It does not currently:

- obtain a valid block template from Bitcoin Core;
- build a coinbase transaction;
- calculate a transaction Merkle root;
- update extranonce/time/version rolling fields;
- compare candidates against the exact compact target and submit a valid block;
- connect to a Stratum pool or submit shares;
- credit hashes toward a cumulative percentage of a block.

Do not describe it as network-connected Bitcoin mining unless those missing components are implemented and verified.

## File map

| File | Responsibility | Editing notes |
|---|---|---|
| `index.html` | Entire UI and embedded CSS | Keep element IDs stable unless `app.js` changes in the same patch. |
| `app.js` | Worker orchestration, aggregation, persistence, rendering, chart, CSV, network display | Main integration surface. Avoid broad rewrites. |
| `miner-worker.js` | Repeated 80-byte double-SHA-256 work, per-batch best/worst, 53-bit ordering prefixes | Performance-sensitive. Test correctness and UI responsiveness after edits. |
| `sha256.js` | Pure JavaScript SHA-256 and SHA-256d | Cryptographic core. Change only with test vectors. |
| `server.py` | Loopback static server and `/api/network` proxy/cache | Must remain bound to `127.0.0.1` unless Ricky explicitly approves wider exposure. |
| `start.command` | macOS launcher | Keep executable bit when cloning or packaging. |
| `VERSION` | Current release string | Update only for an actual release. |
| `tests/` | Repeatable correctness and smoke checks | Run before any handoff or release. |

## Current data flow

1. `app.js` creates one or more `miner-worker.js` Web Workers.
2. Each worker hashes an 80-byte synthetic header repeatedly.
3. Each batch returns:
   - hash count;
   - best and worst full 256-bit displayed hash;
   - difficulty estimates for those extrema;
   - one 53-bit numerical prefix for every generated hash.
4. `app.js` groups batches by integer Unix second.
5. It sorts the combined prefixes to display the median ordering prefix.
6. Best/worst records are persisted in `localStorage` under `rickyMinerV7State`.

## Known technical limitations and likely next fixes

### P1 — exact second attribution

`miner-worker.js` records the second once at the beginning of a batch. A batch that crosses a wall-clock boundary is assigned entirely to its starting second. For strict by-the-second statistics, split the batch at the time boundary or timestamp smaller chunks.

### P1 — median calculation overhead

`app.js` copies and sorts every received 53-bit prefix each time the UI renders. This can consume CPU and lower the displayed hashrate. Safer approaches include:

- calculate/finalize the previous second only once after it closes;
- use a quickselect algorithm rather than full sort;
- use an exact fixed-width histogram only if acceptable precision is specified;
- move median aggregation into a dedicated worker.

Preserve the distinction between an exact 256-bit median hash and the current approximate 53-bit ordering prefix.

### P1 — synthetic work is not a valid Bitcoin job

Workers hash random/synthetic 80-byte headers. Implementing actual solo mining requires a Bitcoin Core RPC or trusted Stratum job source. This is a separate architectural lane and should not be slipped into a UI-only patch.

### P2 — record index precision

A new best record is saved after the entire worker batch is received, so `totalHashes` is the end-of-batch count rather than the exact ordinal of the winning hash. Add an in-batch offset if exact indexing matters.

### P2 — hash comparison

`app.js` uses `localeCompare` on fixed lowercase hexadecimal strings. Replace with direct code-unit comparison (`a < b`, `a > b`) or byte comparison to avoid locale-dependent behavior.

### P2 — local persistence scope

Records are stored by browser origin. A different port, hostname, browser profile, or cleared browser data produces a separate record store. Consider explicit JSON import/export before changing storage technology.

### P3 — platform launcher coverage

Only a macOS `start.command` launcher is included. A Windows `.bat`/PowerShell launcher can be added as an isolated non-overlapping task.

## Safe collaboration protocol

1. Read this file and `README.md` before editing.
2. Pull the latest `main` and create a narrow feature branch.
3. Declare one narrow lane and the exact files it owns.
4. Do not edit a file another chatbot has claimed unless ownership is explicitly handed off.
5. Helpers may review, investigate, benchmark, or write tests without creating competing production edits.
6. Before integrating, compare against the latest `main` and inspect the final diff for unrelated removals.
7. Run `tests/run_tests.sh` and perform the browser acceptance checks below.
8. One integration owner updates `VERSION`, `README.md`, and the changelog for a release.
9. Report changed files, commit or PR link, test results, unresolved risks, and the next owner.

## Browser acceptance checks

- Dashboard opens at `http://127.0.0.1:8791/`.
- Start creates workers and hashrate increases.
- Pause freezes new hashing and Resume restarts it.
- Reset clears only session counters, not persistent record history.
- Current-second best is numerically less than or equal to median prefix, and worst is greater than or equal to it at the represented precision.
- Current-second count changes every second without obvious multi-second carryover.
- All-time best can only improve numerically downward.
- All-time worst can only worsen numerically upward.
- Reload preserves saved records.
- CSV export opens as valid rows with timestamp, difficulty, hash, and session count.
- Network API failure leaves local hashing functional.
- Browser remains responsive at each supported worker and batch-size setting.

## Release handoff template

```text
Lane owner:
Scope:
Files changed:
Base commit:
Behavior added or fixed:
Tests run and results:
Manual browser checks:
Known limitations:
Commit/PR status:
Next owner/action:
```
