# Reward v8 integration status

- Live-work generation fix commit: `41b591c0a7fd0b960f8de9eb98eab70dee09afd8`.
- Mac launcher isolation commit: `8eb0163cfefc987a3653eea3bed5d4b57c35a5c3`.
- Live dashboard API repair commit: `e4297b517552036418150546c96c5309bbb0846b`.
- Eligibility safeguard commit: `b07bed0cf863673e03b043160f63a5d37e71cb73`.
- v6 remains authoritative for live Stratum subscription, authorization, job/header construction, SHA-256d hashing, target checks, and `mining.submit`.
- v7 measurement features are integrated into the real worker path: current-second best/median/worst, exact record history, current-block/session/lifetime scopes, target progress, and CSV export.
- Synthetic browser mining mode has been removed from the combined dashboard.
- The browser consumes `/api/events` `state` events, unwraps `/api/start` responses, reads nested eligibility evidence, and refreshes state after Stop/Clear actions.
- The corrected Mac launcher uses local port `8792`, waits for its own `/api/status` endpoint before opening the browser, fails visibly if startup does not succeed, and shows `BUILD: UI/API FIX 2 · LOCAL PORT 8792` in the page header.
- The server now takes the authoritative job generation from the constructed `work` event, not the earlier pool `job` notification. Fresh hash batches therefore match the active work generation and can satisfy the eligibility gate.
- Reward eligibility fails closed unless connection, subscription, authorization, a fully constructed live job, submission readiness, and a fresh positive-count hash batch tied to the current job and generation are all true.
- Hash evidence is reset on stop, disconnect, miner stop, each new pool job, and each newly constructed work generation; evidence older than five seconds cannot keep the green eligibility badge active.
- Automated checks cover syntax, Bitcoin SHA-256d/header vectors, compact targets, mainnet address validation, per-second telemetry, browser/server API contracts, launcher isolation, work/batch generation agreement, the fresh-hashing eligibility gate, event bridging, and a full local mock Stratum cycle through pool acceptance.

## Remaining release validation

Run the rebuilt port-8792 Mac package with Ricky's intended public payout address and confirm that the visible build marker is present and the badge becomes green after fresh hashes arrive for the current constructed work generation.
