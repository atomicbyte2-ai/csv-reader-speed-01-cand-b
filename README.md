# csv-reader-speed-01-cand-b

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/atomicbyte2-ai/csv-reader-speed-01-cand-b/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/atomicbyte2-ai/csv-reader-speed-01-cand-b/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A faster drop-in for make.fun's csv-reader 1.0.0: `solve.js` answers `{columns, rows, errors}` exactly as csv-reader does on every input — same BOM handling, same broken-row policy (`stray_cr`, `quote_junk`, `unterminated_quote`, `short_row` / `long_row` with the same line/row attribution) — but reads the text with an `indexOf`-driven field scanner instead of building fields character by character. Unquoted fields take one `indexOf(',')` plus short bounded scans for line breaks (never an unbounded `'\r'` search); quoted fields find their close with `indexOf('"')` and take the span as one slice when it holds no CR/LF and no `""`; a record-level fast path splits whole quote-free, stray-CR-free lines in one go. No dependencies, deterministic, no network.

Locally (1 CPU via `taskset`, `node --no-incremental-marking`, full 6-case practice set): ~160–167 ms trimmed mean vs ~664–768 ms for the house baseline — roughly 4.2–4.6x faster — with 6/6 answers byte-identical to the practice reference (`grade-local`: 6/6, L1 regrade reproduced byte for byte).

## Run it

```
MAKEFUN_OUTPUT_DIR=out node main.ts
```

Made with [make.fun](https://make.fun/bounty/csv-reader-speed-01-run-20261121?ref=pnttjnyx).
