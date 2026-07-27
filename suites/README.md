# Which suite should I run?

**Use `combined-159.json`.** It is the working suite — every task, every fix, and it
is the one the published results were measured on.

The other five files exist because they are the lineage, and deleting them would
break the reproducibility of numbers already published. They are not five
alternatives to choose between.

```
discriminating-41   41 tasks   the first suite. 7 categories, gated on two answers.
hard-pool-59        59         authored to be HARD. Yielded 3 discriminators —
                               a task both models fail is a tie too.
      └── together ──> combined-100          the union of those two, exactly
                          │
                          │ scope="last_line" added to 68 answer-style tasks
                          ▼
                       combined-100-lastline
                          │
mined-pool          59    │    mined from the four shapes that empirically
      └── together ───────┴──> combined-159   <-- USE THIS
```

## Why the pairs are kept

`combined-100` and `combined-100-lastline` differ **only** in a `scope` field on 68
tasks. That one field is the whole point of one of the findings: scoring the full
reply turned a config that narrates into a config that looks less accurate, and the
two files are what make the before-and-after checkable. Keeping just one would leave
`8–0, p=0.008` and `6–0, p=0.031` as numbers a reader has to take on faith.

`discriminating-41` and `hard-pool-59` are the two halves of `combined-100`. Their
separate runs are what show the authored-for-difficulty pool doing *worse* than
ordinary tasks at discriminating.

## Anatomy of a task

```json
{"id": "cyclist-two-legs",
 "category": "computation",
 "prompt": "...Show your work, then end your reply with a final line of exactly this form...",
 "grader": "number", "expected": 78, "tol": 0.01, "scope": "last_line"}
```

`id` and `prompt` plus the grader and its answer key all feed the `suite_hash`, so
editing an expected value moves the hash instead of silently changing what a score
meant.

## Admission

Nothing is in a suite here that did not pass three gates:

1. an agent derives the answer from the **prompt alone**, never shown the author's
   value — disagreement kills the task
2. the predicate must PASS that independently derived answer (grading the author's
   would be circular — it may have been reverse-engineered from the predicate)
3. the predicate must FAIL a plausible-but-wrong answer

Gate 1 exists because gates 2 and 3 alone let a task ship with `expected = 52.34`
when the answer is 52.33: the same author wrote the key and the answer that checked
it, and the same arithmetic slip was in both.
