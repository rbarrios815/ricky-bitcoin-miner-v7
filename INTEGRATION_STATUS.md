# Reward v8 integration status

- Eligibility safeguard commit: `b07bed0cf863673e03b043160f63a5d37e71cb73`.
- v6 remains authoritative for live Stratum subscription, authorization, job/header construction, SHA-256d hashing, target checks, and `mining.submit`.
- v7 measurement features are integrated into the real worker path: current-second best/median/worst, exact record history, current-block/session/lifetime scopes, target progress, and CSV export.
- Synthetic browser mining mode has been removed from the combined dashboard.
- Reward eligibility now fails closed unless connection, subscription, authorization, a fully constructed live job, submission readiness, and a fresh positive-count hash batch tied to the current job and generation are all true.
- Hash evidence is reset on stop, disconnect, miner stop, and every new live job; evidence older than five seconds cannot keep the green eligibility badge active.
- Automated checks cover syntax, Bitcoin SHA-256d/header vectors, compact targets, mainnet address validation, per-second telemetry, the fresh-hashing eligibility gate, event bridging, and a full local mock Stratum cycle through pool acceptance.

## Remaining release validation

Before merging this draft to `main`, run the finished application with Ricky's intended public payout address and confirm authorization, live-job receipt, fresh live hash batches, and the active submission path. The prior Braiins validation proved endpoint connectivity and a correlated submission response, but it did not validate Ricky's payout identity or a qualifying share.
