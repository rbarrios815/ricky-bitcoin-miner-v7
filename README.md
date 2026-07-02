# Ricky Bitcoin Mining Control Center v7

A local browser-based SHA-256d mining measurement dashboard.

## Start on Mac

1. Unzip the folder.
2. Double-click `start.command`.
3. The dashboard opens at `http://127.0.0.1:8791/?version=v7`.

Terminal alternative:

```bash
cd ~/Downloads/ricky-browser-miner-v7
chmod +x start.command
./start.command
```

## New in v7

- Best hash in the active current-second batch.
- Worst hash in the active current-second batch.
- Median hash in the active current-second batch using all reported 53-bit ordering prefixes. This is memory-safe and preserves numerical order except for astronomically unlikely equal-prefix ties.
- Worst hash of all time next to best hash of all time.
- Persistent record-beating hash log stored locally in the browser.
- CSV export for record hashes.
- Existing record-progress chart, pool/share target, Bitcoin network target, time since improvement, and average record interval.

## Important

This performs real double-SHA-256 calculations, but it is not competitive with ASIC hardware. Browser hashes do not accumulate into a literal percentage of a block; each hash is a separate attempt.

## Updating this project with another chatbot

Read `COLLABORATION_HANDOFF.md` before editing. `CHATBOT_UPDATE_PROMPT.txt` is a ready-to-paste takeover prompt, and `tests/run_tests.sh` runs the required automated checks.
