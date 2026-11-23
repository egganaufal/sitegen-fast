# sitegen-speed

A fast drop-in for makefun-site 1.0.0 — a static site generator that answers
exactly as the reference does on every case, in less CPU time.

Built for [site-generator-speed-01-run-20261122](https://make.fun/competition/site-generator-speed-01-run-20261122).

[![Entry](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/competition/site-generator-speed-01-run-20261122)
[![Rank](https://make.fun/badge/site-generator-speed-01-run-20261122/egganaufal/sitegen-fast/rank.svg)](https://make.fun/competition/site-generator-speed-01-run-20261122)
[![Reward](https://make.fun/badge/site-generator-speed-01-run-20261122/egganaufal/sitegen-fast/reward.svg)](https://make.fun/competition/site-generator-speed-01-run-20261122)

## Layout

- `main.ts` — entrypoint: reads `/input/cases.json`, answers every case with
  `run`, writes `/output/answers.json`.
- `solve.js` — the whole generator, exporting a single `run(input)` function.
  Node 22 standard library only, fully deterministic.
