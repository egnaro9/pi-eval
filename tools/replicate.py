#!/usr/bin/env python3
"""Replication analysis, fixed in advance of the data.

Reads runs/PREREGISTRATION.md's parameters as code: reps 4-6 only, rate_margin
0.5, both stability rules, no pooling with reps 1-3. Written and committed before
the sweeps finished so it cannot be shaped by the outcome.

Prints the three pre-registered predictions and whether each held.
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLI = ROOT / "skills" / "grade" / "scripts" / "gradecli.py"
SUITE = ROOT / "suites" / "combined-159.json"
REPS = (4, 5, 6)
# rate_margin is gradecore's DEFAULT_RATE_MARGIN (0.5). It was a gradecli flag when
# this was registered; the flag was removed because a threshold the reader can dial
# after seeing the result is not a threshold. The registered VALUE is unchanged.
MODELS = {"haiku": "haiku-4-5", "sonnet": "sonnet-4-6"}


def grade(model: str, rep: int) -> Path:
    ans = ROOT / "runs" / "all" / f"rep{rep}-{MODELS[model]}.json"
    # Write regenerated grades to a temp dir. Grading in place would restamp six
    # tracked files with the current gradecore_version, so merely RUNNING the
    # replication would dirty the evidence it exists to check.
    tmp = Path(tempfile.gettempdir()) / "pi-eval-replicate"
    tmp.mkdir(exist_ok=True)
    out = tmp / f"rep{rep}-{model}.graded.json"
    r = subprocess.run([sys.executable, str(CLI), "run", str(SUITE), "--answers", str(ans)],
                       capture_output=True, text=True)
    if r.returncode == 2:
        raise SystemExit(f"grading refused for {ans}: {r.stderr.strip()}")
    out.write_text(r.stdout)
    return out


def compare(rule: str) -> dict:
    a = [str(grade("haiku", i)) for i in REPS]
    b = [str(grade("sonnet", i)) for i in REPS]
    argv = [sys.executable, str(CLI), "compare", a[0], b[0],
            "--rep-a", *a[1:], "--rep-b", *b[1:],
            "--stability", rule,
            "--name-a", "haiku-4-5", "--name-b", "sonnet-4-6"]
    r = subprocess.run(argv, capture_output=True, text=True)
    if r.returncode == 2:
        raise SystemExit(f"compare refused: {r.stderr.strip()}")
    return json.loads(r.stdout)


def main() -> int:
    strict, rate = compare("strict"), compare("rate")

    # The suite must be the one that was frozen, or the replication is of a
    # different question and the pre-registration does not apply.
    pooled = json.loads((ROOT / "runs" / "all" / "haiku-r1.graded.json").read_text())
    assert strict["suite_hash"] == pooled["suite_hash"], "suite hash moved; replication void"

    for name, d in (("strict", strict), ("rate", rate)):
        print(f"{name:>6}: {d['wins_a']}-{d['wins_b']}  ties {d['ties']}  "
              f"unstable {d['unstable']}  informative {d['informative']}  "
              f"p={d['p']:.4f}  decisive={d['decisive']}")

    haiku_ahead = lambda d: d["wins_a"] > d["wins_b"]
    checks = [
        ("1. rate favours haiku significantly",
         rate["decisive"] and haiku_ahead(rate)),
        ("2. strict does NOT reach significance",
         not strict["decisive"]),
        ("3. strict discards >= 10 tasks",
         strict["unstable"] >= 10),
    ]
    print()
    for label, held in checks:
        print(f"  {'HELD    ' if held else 'FAILED  '} {label}")

    if not checks[0][1]:
        print("\nPrediction 1 failed. Per the pre-registration the rate finding is"
              "\nWITHDRAWN, not re-explained.")
    if haiku_ahead(strict) is False and strict["informative"]:
        print("\nDirection flipped under strict — both prior results are suspect.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
