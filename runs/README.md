# The runs behind every number in the README

Raw artifacts, kept on purpose. A tool whose argument is *verify claims against
data* should ship its data; otherwise the reader is trusting a summary again.

The headline numbers in the top-level README map to files here and to a command
that regenerates them. If a command below disagrees with the README, the README is
wrong.

Coverage is **partial and named as such**: the commands below cover the thinking
comparison and the 159-task model comparison. `noise/`, `pool/`, `cfg/` and
`mined/` are the intermediate experiments those were built from — the first
noise-floor measurement, the pool authored to be hard, the 100-task stage, and the
mined pool. Their numbers appear in the README narrative without a command here.
Saying "every number" would have been the same overclaim this tool exists to
catch.

## Directories

| dir | what it is |
|---|---|
| `noise/` | haiku ×3 **and sonnet ×3** on `discriminating-41` — the first noise-floor measurement |
| `pool/` | haiku, sonnet ×3 on `hard-pool-59` — the pool authored to be hard |
| `cfg/` | haiku, sonnet ×3 on `combined-100`, both scorings (`ll-` = `last_line`) |
| `think/` | haiku `thinking=high` vs `off` ×3 on `combined-100` — the decisive result |
| `mined/` | haiku, sonnet ×3 on `mined-pool` — tasks mined from shapes that worked |
| `all/` | haiku, sonnet on `combined-159`; reps 1–3 pooled, reps 4–6 the replication |

`*.json` is a flat `{task_id: answer}` map. `<name>.json.meta.json` is the run
provenance — model, thinking level, **observed** active tools, per-task latency
and token usage. `*.graded.json` is gradecli's verdict record.

## How `all/` was assembled — read this before trusting the pooled result

`all/{haiku,sonnet}-r{1,2,3}.json` are **not sweeps**. Each is an exact dict merge
of the matching `cfg/` file (100 tasks) with the matching `mined/` file (59), which
is why they carry no `.meta.json`. Reps **4–6** (`all/rep{4,5,6}-*.json`) are fresh
159-task sweeps and do have one.

So the README's "pooling all six repetitions made it worse" compares three assembled
repetitions against three fresh ones. Merging is sound — every task runs in its own
session, so which sweep a task ran in cannot affect its answer — but a reader should
be told, not left to infer it from a missing sidecar.

## Reproducing each claim

**thinking=high vs thinking=off — 6–0, p=0.031, 2.49× cost**

```bash
python3 skills/grade/scripts/gradecli.py compare \
  runs/think/ll-high-r1.graded.json runs/think/ll-off-r1.graded.json \
  --rep-a runs/think/ll-high-r{2,3}.graded.json \
  --rep-b runs/think/ll-off-r{2,3}.graded.json \
  --meta-a runs/think/haiku-high-r{1,2,3}.json.meta.json \
  --meta-b runs/think/haiku-off-r{1,2,3}.json.meta.json
```

`ll-*` are graded against `combined-100-lastline`. The full-scope grading of the
same answers is in the same directory and gives 8–0, p=0.008 — the number before
two verbosity artifacts were removed. Both are kept; the README explains why the
smaller one is the honest one.

**haiku vs sonnet on 159 tasks — 7–1, p=0.070 strict / 13–2, p=0.0074 rate**

```bash
python3 skills/grade/scripts/gradecli.py compare \
  runs/all/haiku-r1.graded.json runs/all/sonnet-r1.graded.json \
  --rep-a runs/all/haiku-r{2,3}.graded.json \
  --rep-b runs/all/sonnet-r{2,3}.graded.json --stability strict
```

Swap `--stability rate` for the other. `PREREGISTRATION.md` records the
prediction for reps 4–6, written before those runs existed; `tools/replicate.py`
runs the fixed analysis.

**Noise floors** are printed by any `compare` with repetitions on both sides, as
`noise_floor_a` / `noise_floor_b`.

## What is not here

The `thinking=medium` vs `"off"` comparison that produced near-total ties and a
cost ratio near 1. `--thinking` was inert at the time, so both sides ran at
medium — a config compared with itself. The runs were deleted rather than kept,
which is why the README describes that result qualitatively instead of quoting
figures: they are no longer checkable against anything, and a precise number
nobody can verify is worse than an honest description.

## Answers are not deterministic

Re-running a sweep produces different answers; the models are sampled. Grading
*is* deterministic — the same answers file always produces the same verdicts.
That split is the point of the whole design, and it is why comparisons need
repetitions and why the suite hash has to be stable across them.
