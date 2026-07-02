# Ricky Bitcoin Reward Miner v8

This is the merged reward-mode build:

- **v6 remains authoritative for real mining:** raw TCP Stratum V1 connection, subscription, authorization, live job construction, Bitcoin double-SHA-256 hashing, share-target checking, and `mining.submit`.
- **v7 supplies the measurement system:** best/median/worst hash for the measured second, persistent lifetime records, exact timestamps and work context, current-block scope, progress chart, and CSV evidence export.

There is no synthetic mining mode in the dashboard. The green **REWARD-ELIGIBLE WORK ACTIVE** badge appears only while all of these are true:

1. The pool TCP connection is active.
2. Stratum subscription succeeded.
3. The payout worker was authorized.
4. A live Bitcoin job was received and constructed.
5. The worker is hashing that live header space.
6. The `mining.submit` path is writable for that job.

If any condition fails, the badge turns off immediately.

## Start on Ricky's Mac

```bash
chmod +x start.command
./start.command
```

Open: `http://127.0.0.1:8791/?version=reward-v8`

Node.js 18 or newer is the only runtime dependency.

## What is recorded

The local `.miner-state.json` file stores:

- lifetime hash count
- every lifetime best-hash record
- exact timestamp and full hash
- previous record and improvement multiplier
- session/lifetime/current-block hash numbers
- live job ID, generation, extranonce2, ntime, version, worker, and nonce
- pool and network targets
- whether the work was reward-eligible when hashed
- real submission and pool acceptance/rejection outcomes

The file is ignored by Git and contains no private key or seed phrase.

## Safety and reality

- Only a **public Bitcoin payout address** is sent as the pool username.
- Never enter a seed phrase, private key, wallet file, PIN, or xpub.
- The web server binds only to `127.0.0.1`.
- Pool endpoints are allowlisted in `server.js`.
- Raw Stratum V1 is not encrypted; use only a pool endpoint you trust.
- CPU mining on a MacBook is reward-eligible but extraordinarily unlikely to find a Bitcoin block and is not expected to be profitable.
- A better historical hash is evidence of past luck, not cumulative progress toward the next block.

## Tests

```bash
npm test
```

The suite covers known header construction, SHA-256d and target vectors, Bitcoin address checks, exact per-second telemetry, and a full local mock cycle:

`subscribe → authorize → live job → hash → mining.submit → pool acceptance`
