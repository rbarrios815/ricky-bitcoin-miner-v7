# Implementation sources and boundaries

- Bitcoin block-header serialization and double-SHA-256 behavior are validated by fixed test vectors in `tests.js`.
- Stratum V1 messages used by the implementation: `mining.subscribe`, `mining.authorize`, `mining.set_difficulty`, `mining.set_extranonce`, `mining.notify`, and `mining.submit`.
- Optional observed block height comes from the public mempool.space API through the local server; live Stratum `nBits` remains the authoritative network target used for candidate checks.
- The pool endpoint allowlist was inherited from the working v6 source. Endpoint availability and pool payout terms can change and must be confirmed with the pool operator.
