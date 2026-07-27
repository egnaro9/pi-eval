# Pre-registration — replication of the `rate` stability result

Written **before** collecting reps 4–6. Committed before the runs existed, so the
timestamp in git history is checkable against the run files' mtimes.

## Why

On reps 1–3 of `suites/combined-159.json`, the two stability rules disagreed:

```
strict   haiku 7–1  sonnet   informative 8    p=0.070    not significant
rate     haiku 13–2 sonnet   informative 15   p=0.0074   significant
```

The `rate` rule was written *after* seeing that `strict` returned p=0.070. Its
motivation was independent — a measured property of the strict rule, that discards
rise with repetitions — but a rule built after seeing a non-significant result, by
the person who wanted a significant one, cannot be evaluated on the data that
prompted it. The margin (0.5) is a judgement call, not a test.

## The prediction

Three fresh repetitions of each config (reps 4–6), same frozen suite, same models,
analysed **only** on the new data:

1. **`rate` will again favour haiku-4-5 significantly** (p < 0.05, haiku ahead).
2. **`strict` will again fail to reach significance** (p ≥ 0.05).
3. `strict` will discard more tasks than `rate` — 10 or more, against reps 1–3's 13.

## What counts as a refutation

- Prediction 1 fails → the significant result was an artifact of the data that
  selected the rule. The `rate` finding gets withdrawn, not re-explained.
- Direction flips (sonnet ahead under either rule) → both prior results are
  suspect and the suite goes back to being described as unable to decide.
- If 1 holds and 2 fails, that is *stronger* than predicted, and I will say the
  prediction was too conservative rather than claiming I called it.

## Fixed in advance

- Suite: `suites/combined-159.json`, hash checked equal to reps 1–3.
- Models: `anthropic/claude-haiku-4-5`, `anthropic/claude-sonnet-4-6`.
- Thinking: default (medium), asserted by sweep preflight.
- `rate_margin`: **0.5**, unchanged. Not to be tuned after seeing the result.
- Analysis: reps 4–6 alone. No pooling with 1–3 for the replication test.
- No task edits between now and the analysis.

Anything I change after this point gets recorded as a change, not folded in
silently.
