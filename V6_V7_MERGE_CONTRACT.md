# v6 reward engine + v7 dashboard merge contract

## Product requirement

The combined build must perform only real, reward-eligible Bitcoin mainnet mining work in its normal mining mode. A synthetic/local hashing mode may remain solely as an explicitly labeled test mode and must never claim reward eligibility.

## Authority by subsystem

### Preserve from v6

The imported v6 implementation is authoritative for every component that can affect whether work is valid or submitted:

- upstream mining connection
- subscription and authorization
- live job reception
- extranonce and coinbase handling
- merkle-root construction
- version, ntime, nbits and nonce handling
- share target and network target
- share or block submission
- accepted/rejected response handling
- payout identity and worker configuration

Do not replace working v6 protocol behavior merely to fit v7's existing synthetic worker API.

### Preserve from v7

The v7 implementation is authoritative for measurement and evidence that does not alter mining-work validity:

- current-second best, median and worst hash measurements
- exact record-breaking hash and timestamp history
- session, lifetime and current-network-block scopes
- current-tip reset behavior
- CSV export
- hashrate/runtime evidence
- progress and gap-to-target displays
- truthful outcome metadata

## Runtime modes

### Reward mode

The UI may show `Reward eligible` only after the backend reports all of the following for the current process:

1. upstream connection established
2. authorization accepted
3. a live mainnet job received
4. current job identifiers and target received or derived from the live upstream job
5. hashing is operating on the exact submitted-work header space
6. the submission path is enabled and associated with the current job

Loss of any required state immediately removes the eligibility label.

### Test mode

Test mode may use synthetic headers or fixtures, but it must:

- display `TEST MODE — NOT REWARD ELIGIBLE`
- never increment accepted-share or block-candidate counters
- never report a synthetic target match as a submitted share or valid block
- use separate saved-history metadata from reward mode

## Event bridge

The mining engine should emit immutable events to the measurement dashboard instead of allowing dashboard code to reconstruct protocol state:

- `connection_state`
- `authorization_state`
- `job_received`
- `hash_batch`
- `share_submitted`
- `share_result`
- `block_candidate`
- `network_tip_changed`

Each hash-batch record should carry the current live job id, worker id, nonce range, ntime/version details when applicable, share target, network target, and whether submission was possible for that exact work.

## Required validation before merge

- v6 baseline still starts and reaches its prior live state before integration changes
- JavaScript and backend syntax checks pass
- known SHA-256d vectors pass
- v6 job/header construction produces identical bytes before and after instrumentation
- a controlled low-difficulty Stratum test confirms submission formatting and response correlation
- eligibility indicator fails closed under disconnect, auth rejection, stale job, and disabled submission path
- accepted/rejected counters are driven only by upstream responses
- test mode cannot claim reward eligibility
- existing v7 record/reset tests pass

## Release rule

Do not merge the integration branch to `main` merely because the dashboard renders or hashes locally. Merge only after the preserved v6 live path is imported, compared, instrumented without changing work bytes, and tested end-to-end.
