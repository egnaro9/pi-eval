# What running it found

Everything here was measured on this repo's own suites and is reproducible from
[`runs/`](runs/README.md). It sat in the README until that document was 427 lines
with the tool's behavioural contract at line 404.

Most of these findings are bugs in the instrument, found by running it. That is
the honest shape of the work and the reason it is written down rather than
summarised.

---

## Headless sweeps

```bash
node tools/sweep.mjs --suite suites/combined-159.json \
                     --model anthropic/claude-haiku-4-5 \
                     --reps 3 \
                     --out runs/my-run.json
```

`--reps` exists because comparing two configs needs at least two runs per side,
and leaving that as a shell loop the user has to know to write is how single-run
comparisons get published. It prints the exact grade and compare commands when
it finishes, `--rep-a`/`--rep-b` already filled in.

Fresh in-memory session per task, so task N-1 cannot contaminate task N. Tools are
disabled and the assertion is checked at runtime with `getActiveToolNames()`, not
assumed — the suite file with every expected value is *in this repo*, so a model
with a read tool could answer by looking up the key, and that answer would look
like the best one.

It refuses to record a missing **or truncated** response as an answer. A reply cut
off at the output-token cap is an infrastructure failure wearing the costume of a
result: `"Asta"` for a task expecting `"Astana"` grades as a model that got the
capital wrong, and the sign test counts that as a directional loss.

Cost is recorded by `tools/sweep.mjs`, not by `/eval` — `/eval` shells out to
`pi -p` per task, which returns text and no usage. Comparisons run through the
extension report accuracy only; the spend numbers below come from sweeps.

## Measure the noise floor before you believe a difference

```bash
python3 skills/grade/scripts/gradecli.py compare A.json B.json \
  --rep-a A2.json A3.json --rep-b B2.json B3.json
```

With repetitions on both sides this switches to repeated measures, and applies one
rule: **a task where a config disagrees with itself carries no direction, and is
discarded exactly like a tie.**

That rule is not theoretical. Running claude-haiku-4-5 three times against the same
100 tasks and comparing those runs *to each other* yields 2.67 "informative" tasks
from within-model variance alone. Any real finding has to clear that. The output
reports both configs' noise floors next to the verdict so a reader can see the bar.

It refuses to enter repeated mode with repetitions on only one side — assuming the
unrepeated config is stable is precisely the assumption the mode removes.

## What running it actually found

> **This section is the first experiment, on 100 tasks, scored on the full reply.**
> A later, larger run supersedes its verdict — see
> [*"Cannot decide" and "indistinguishable"*](#cannot-decide-and-indistinguishable-are-different-findings)
> below. It is kept because the progression is the point: the same instrument said
> "I cannot answer this" before it said anything else.

Three repetitions per config, `claude-haiku-4-5` vs `claude-sonnet-4-6`,
`suites/combined-100.json`:

```
haiku   98 98 98 /100     noise floor 2.00
sonnet  95 96 96 /100     noise floor 0.67

haiku wins 3 · sonnet wins 1 · 92 tied · 4 unstable
informative 4 · min_p 0.125 · VERDICT: this suite cannot decide
```

Two results worth the electricity:

**At this size the suite could not separate two models a leaderboard would happily
rank.** 92 of 100 tasks tie. Six informative tasks are needed at α=0.05 and there are
four, so no split of this data could reach significance — which the tool says out loud
instead of reporting a tie.

**Haiku beats Sonnet here, 3 wins to 1.** Not a bug. All three keys were re-derived
by hand: 1900 is not a leap year (Sonnet counts it); a warranty starting later with a
shorter term can still expire last; the imperial *gallon* is larger but the imperial
*fluid ounce* is smaller, 160 to the gallon against 128. Narrow trap questions are not
a capability ranking, and a suite made of them measures something other than what a
leaderboard claims to.

## "Cannot decide" and "indistinguishable" are different findings

Pooling more tasks moved the model comparison across the power threshold, and the
verdict changed category rather than degree:

```
100 tasks   informative 4   min_p 0.125   "this suite CANNOT DECIDE between them"
159 tasks   informative 8   min_p 0.008   "INDISTINGUISHABLE on this suite"
            haiku 7 · sonnet 1 · 138 tied · 13 unstable · p=0.070
```

At 100 tasks no split of the data could have reached significance, so reporting a
tie would have been a claim the data could not support. At 159 a clean sweep of 8
would give p=0.008 — the suite can now answer the question. It answered *not
significantly different*, with Haiku leading 7 to 1.

Suggestive. Not significant. Two more informative tasks in the same direction and
it would be, which is exactly why the number to watch is `min_p` and not the
p-value alone.

The extra 59 tasks were **mined, not authored for difficulty**. A pool written to
be hard yielded 3 discriminators from 59. A pool targeting only the four shapes
that had empirically separated the models — an excluded transformation sitting
next to the answer, a known rule whose exception lands inside the count, a
per-item comparison where the biggest single column is the wrong row, and a
*true* premise pointing the wrong way — more than doubled the non-tie rate,
12 of 59 against 9 of 100.

**The binding constraint is no longer difficulty. It is stability.** 13 of 159
tasks were discarded because a config disagreed with itself, and nearly all of
them are Haiku at 3/3 against Sonnet at 1/3 or 2/3 — real differences the tool
refuses to count.

I first wrote here that this was fixable "with more repetitions". That is
backwards, and the data says so. Every extra repetition is another chance to
observe disagreement, so the discard count RISES:

```
2 reps   ~8.7 discarded   ~10.3 informative
3 reps    13  discarded      8  informative
```

In the limit the strict rule throws away every genuinely stochastic task. More
measurement cannot fix it. Only a different rule can.

### Two rules disagreed, so I pre-registered a replication

On reps 1–3 the two stability rules gave different answers, and the weaker one
gave the significant result:

```
strict   7–1    informative 8    p=0.070    not significant
rate    13–2    informative 15   p=0.0074   significant
```

I ran strict, got p=0.070, and *then* built the rule returning p=0.0074. Its
motivation was independent — a measured property of the strict rule — and I found
that before checking whether it moved a verdict. That is also exactly what
everyone who p-hacks believes about themselves.

So the prediction, the refutation conditions, and the fixed parameters went into
[`runs/PREREGISTRATION.md`](runs/PREREGISTRATION.md) **before** reps 4–6 existed,
and the analysis into [`tools/replicate.py`](tools/replicate.py) while the sweeps
were still running — a pre-registration that leaves the analysis to be written
afterwards only relocates the discretion.

```
reps 4–6, fresh data, analysed alone
  strict   9–1    informative 10   p=0.0215   decisive
  rate    11–2    informative 13   p=0.0225   decisive

  HELD    rate favours haiku significantly
  FAILED  strict does NOT reach significance      <- too conservative
  HELD    strict discards >= 10 tasks
```

Prediction 2 failed by being wrong in the stronger direction: `strict`, the rule
I trust, reached significance on data it had never seen. Per the pre-registration
I say the prediction was too conservative rather than claiming I called it.

Both windows point the same way. **On this suite, Haiku 4.5 beats Sonnet 4.6** —
and that is a claim about this suite, which is made of trap questions, not a
capability ranking. A suite built to catch specific slips measures susceptibility
to those slips.

### Pooling all six repetitions made it WORSE

```
                            rule     w–l   unstable  informative      p
reps 4–6 (pre-registered)   strict   9–1      13         10        0.0215  decisive
reps 1–6 pooled             strict   7–1      17          8        0.0703  not
```

Twice the data, less power. Every extra repetition is another chance to observe
a within-config disagreement, and the strict rule discards the task when it does
— so discards climbed from 13 to 17 and informative tasks fell from 10 to 8.

This is the clearest statement of the trade the rule makes. It will never report
noise as signal, and the price is that it grows blinder the harder you look. If
you take one thing from this repo, take that: **a conservative rule is not a free
choice, and the cost is measurable.** `--stability rate` is the other end of it,
and the output always records which rule produced a number.

## The result the tool was built for

Same 100 tasks, same model, one config change. `claude-haiku-4-5`, three
repetitions each, `thinking=high` against `thinking=off`:

```
thinking=high  won 6, lost 0, 84 tied, 10 unstable    p=0.031
               364,287 tokens (142,727 reasoning)     $1.107
thinking=off                                          $0.445
                                       COST RATIO     2.49x
noise floor    high 2.67       off 4.00
```

**This is the same suite that cannot separate Haiku 4.5 from Sonnet 4.6.** It was
never broken — there was nothing there to find. Given a difference that exists, it
finds it at p=0.008 and prices it.

Eight wins is the wrong number, and the reason generalises. `thinking=off`
answers in prose instead of thinking first. On `boundary-31st-weekday` it worked
through the arithmetic, concluded "Friday" — correct — and `exact` scored the
whole reply. On `boundary-overlapping-atat` it listed matches at positions 0, 2,
4, 6, answered "4" — correct — and `which="first"` took the 0. **The model was
right both times.**

Verbosity is not accuracy. But a config change that alters verbosity moves every
position-sensitive grader in the same direction at once, so it does not look like
noise — it looks like a finding.

The fix is `scope="last_line"`, applied to the 68 answer-style tasks and withheld
from the 5 format-compliance ones, where output shape is the thing being measured:

```
graded on the full reply     8 wins, 0 losses, 11 unstable   p=0.008
graded on the last line      6 wins, 0 losses, 10 unstable   p=0.031
```

Both contaminated wins became ties. All six real ones survived, and the p-value
still clears α=0.05. The same six tasks I had picked out by hand fell out of the
rescored run — which is the point: **the correction belongs in the grader, not in
my judgement about which results to believe.**

The six are real. On the Feb-29 count it listed 1892, 1896, 1904, 1908 and then
answered 5. On the warranty table it computed 2023-09-10 plus 36 months as
2025-09-10 and picked the wrong item.

The stability number deserves as much attention as the win count: `thinking=off`
has a noise floor of **4.00 against high's 2.67**, and this comparison threw out 10
unstable tasks where the model-vs-model one threw out 5. Turning thinking off does
not just cost accuracy — it makes the same config answer the same question
differently run to run.

(Under full-reply scoring those floors read 5.33 and 2.00. Both numbers are real;
they are not interchangeable, and quoting one beside a verdict computed under the
other is how a report starts drifting from its own data.)

So: **+6 tasks per 100 and about a third less run-to-run variance, for 2.5x the
money.** That
is a decision someone can actually make. A score without the cost beside it is not.

## The gate that admits a task, and the one it cannot replace

Every task is admitted only if a correct answer PASSES its predicate and a
plausible-but-wrong answer FAILS it. Of 48 authored tasks, 7 were rejected — six for
one cause: `number` defaults to `which="first"`, so a worked solution's first number
is an *operand*. Those graded 3 against an expected 78 and failed the correct answer.

Then a task shipped anyway with `expected=52.34` when the answer was 52.33.

The gate verifies the **predicate**. It cannot verify the **answer key** — because the
same author wrote the key *and* the known-good answer used to check it, and the same
arithmetic slip was in both. Two independent-looking checks, one shared error, zero
detection. Both models got it right and were scored wrong.

The fix is a third gate: an agent derives each answer from the **prompt alone**, never
shown the author's value, and disagreement kills the task. The predicate is then run
against the *independently derived* answer — grading the author's would be circular,
since it may have been reverse-engineered from the predicate.

