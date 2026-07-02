# Reward v8 integration status

- Integration head: `dca01a8bbe6944088d137b390f85de17e78a8491`
- v6 remains authoritative for live Stratum subscription, authorization, job/header construction, SHA-256d hashing, target checks, and `mining.submit`.
- v7 measurement features are integrated into the real worker path: current-second best/median/worst, exact record history, current-block/session/lifetime scopes, target progress, and CSV export.
- Synthetic browser mining mode has been removed from the combined dashboard.
- Reward eligibility fails closed unless connection, subscription, authorization, live job, live hashing, and submission readiness are all true.
- Automated checks cover syntax, Bitcoin SHA-256d/header vectors, compact targets, mainnet address validation, per-second telemetry, and a full local mock Stratum cycle through pool acceptance.
- GitHub Actions final clean-head run #33 passed.

## Remaining release validation

Before merging this draft to `main`, run the branch against the intended live pool endpoint and confirm authorization, live-job receipt, and at least one real share submission response. This is an operational validation; the automated mock cycle has already passed.
