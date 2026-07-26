#!/usr/bin/env python3
"""gradecli — deterministic grading at the command line.

A thin CLI over `gradecore`. It contains no grading logic of its own, on purpose:
gradecore is the single grader shared by model-drift and the crash test, and the
byte-identical `suite_hash` between them is a load-bearing claim. A second
implementation here -- in this file or in TypeScript -- would quietly make that
claim false, so this only marshals JSON in and JSON out.

Two modes:

    gradecli check --grader exact --expected 42 --text "42"
    gradecli run suite.json --answers answers.json

Exit codes:  0 every task passed · 1 at least one failed · 2 bad usage/spec.
The distinction matters: a caller can branch on "did it fail" without parsing.
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Callable, Dict, List

try:
    import gradecore as gc
except ImportError:  # pragma: no cover - environment problem, not logic
    sys.stderr.write(
        "gradecli: gradecore is not installed.\n"
        "  pip install git+https://github.com/egnaro9/gradecore.git\n"
    )
    raise SystemExit(2)


# ---------------------------------------------------------------------------
# SPEC -> GRADER.
#
# Every grader gradecore exposes is reachable from JSON, because the point of a
# skill is that a model can pick the right one without reading Python. Unknown
# keys are an error rather than a silent default: a typo'd grader name that
# quietly became `contains` would produce a plausible score that means nothing.
# ---------------------------------------------------------------------------
def _need(spec: Dict[str, Any], key: str, kind: type) -> Any:
    if key not in spec:
        raise ValueError(f"grader {spec.get('grader')!r} needs {key!r}")
    v = spec[key]
    if not isinstance(v, kind):
        raise ValueError(f"{key!r} must be {kind.__name__}, got {type(v).__name__}")
    return v


def _sev(spec: Dict[str, Any], default: str) -> str:
    return str(spec.get("fail_severity", default))


BUILDERS: Dict[str, Callable[[Dict[str, Any]], Any]] = {
    # scalar / text
    "exact":      lambda s: gc.exact(str(_need(s, "expected", str)), fail_severity=_sev(s, "med")),
    "exact_cs":   lambda s: gc.exact_cs(str(_need(s, "expected", str)), fail_severity=_sev(s, "med")),
    "contains":   lambda s: gc.contains(*[str(x) for x in _need(s, "needles", list)], fail_severity=_sev(s, "med")),
    "regex":      lambda s: gc.regex(str(_need(s, "pattern", str)), fail_severity=_sev(s, "med")),
    "one_of":     lambda s: gc.one_of(*[str(x) for x in _need(s, "allowed", list)], fail_severity=_sev(s, "med")),
    "number":     lambda s: gc.number(float(s["expected"]), float(s.get("tol", 1e-6)),
                                      which=str(s.get("which", "first")), fail_severity=_sev(s, "med")),
    # adversarial
    "must_refuse":  lambda s: gc.must_refuse(fail_severity=_sev(s, "critical")),
    "must_comply":  lambda s: gc.must_comply(fail_severity=_sev(s, "med")),
    "must_abstain": lambda s: gc.must_abstain(fail_severity=_sev(s, "high")),
    "valid_json":   lambda s: gc.valid_json(*[str(x) for x in s.get("required", [])], fail_severity=_sev(s, "med")),
    "injection_resistance": lambda s: gc.injection_resistance(
        *[str(x) for x in _need(s, "forbidden", list)],
        requires=[str(x) for x in s.get("requires", [])],
        fail_severity=_sev(s, "critical")),
    "tool_misuse":  lambda s: gc.tool_misuse([str(x) for x in _need(s, "denylist", list)],
                                             fail_severity=_sev(s, "critical")),
    # retrieval / agent lenses
    "grounding":  lambda s: gc.grounding(float(s.get("threshold", gc.FAITHFULNESS_THRESHOLD)),
                                         severity=_sev(s, "med")),
    "trajectory": lambda s: gc.trajectory(*[str(x) for x in _need(s, "expected_steps", list)],
                                          threshold=float(s.get("threshold", 1.0)),
                                          allow_extra=bool(s.get("allow_extra", True)),
                                          fail_severity=_sev(s, "high")),
}


def build_grader(spec: Dict[str, Any]):
    name = spec.get("grader")
    if name not in BUILDERS:
        raise ValueError(
            f"unknown grader {name!r}. known: {', '.join(sorted(BUILDERS))}"
        )
    return BUILDERS[name](spec)


def grade_input(task: Dict[str, Any], text: str) -> "gc.GradeInput":
    """Only the fields a grader might read. A grader ignores what it doesn't use."""
    return gc.GradeInput(
        text=text,
        prompt=task.get("prompt"),
        retrieved=task.get("retrieved", ()),
        contexts=task.get("contexts", ()),
        citations=task.get("citations", ()),
        tool_calls=task.get("tool_calls", ()),
        gold_ids=task.get("gold_ids", ()),
        expected=task.get("expected"),
    )


def as_dict(v: "gc.Verdict") -> Dict[str, Any]:
    return {"passed": v.passed, "score": v.score, "severity": v.severity,
            "detail": v.detail, "grader_id": v.grader_id}


# ---------------------------------------------------------------------------
# The suite fingerprint. Folds the GRADER and EXPECTED into each identity, not
# just id+prompt -- otherwise editing an answer key leaves the hash unchanged and
# the freeze guarantees nothing. gradecore's docstring calls this out explicitly.
# ---------------------------------------------------------------------------
def identity(task: Dict[str, Any]) -> str:
    g = {k: v for k, v in task.items() if k not in ("id", "prompt")}
    return f"{task.get('id','')}:{task.get('prompt','')}:{json.dumps(g, sort_keys=True)}"


def cmd_check(args: argparse.Namespace) -> int:
    spec: Dict[str, Any] = {"grader": args.grader}
    if args.expected is not None:
        spec["expected"] = args.expected
    if args.needles:
        spec["needles"] = args.needles
    if args.pattern is not None:
        spec["pattern"] = args.pattern
    if args.allowed:
        spec["allowed"] = args.allowed
    if args.spec:
        spec.update(json.loads(args.spec))

    text = args.text if args.text is not None else sys.stdin.read()
    verdict = build_grader(spec)(grade_input(spec, text))
    json.dump(as_dict(verdict), sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0 if verdict.passed else 1


def cmd_run(args: argparse.Namespace) -> int:
    suite = json.loads(open(args.suite).read())
    tasks: List[Dict[str, Any]] = suite["tasks"] if isinstance(suite, dict) else suite
    answers = json.loads(open(args.answers).read()) if args.answers else json.loads(sys.stdin.read())

    results, failed = [], 0
    for t in tasks:
        tid = t.get("id")
        if tid not in answers:
            raise ValueError(f"no answer supplied for task {tid!r}")
        v = build_grader(t)(grade_input(t, str(answers[tid])))
        if not v.passed:
            failed += 1
        results.append({"id": tid, **as_dict(v)})

    n = len(results)
    out = {
        "suite_hash": gc.suite_hash(identity(t) for t in tasks),
        "schema_version": gc.SCHEMA_VERSION,
        "gradecore_version": gc.__version__,
        "n": n,
        "passed": n - failed,
        "failed": failed,
        # Mean of per-task partial credit, not pass-rate: a grader that carries a
        # fraction (grounding, trajectory) would otherwise be flattened to 0/1.
        "score": round(sum(r["score"] for r in results) / n, 6) if n else 0.0,
        "results": results,
    }
    json.dump(out, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0 if failed == 0 else 1


def main(argv: List[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="gradecli",
        description="Deterministic grading over gradecore. No model grades anything.",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("check", help="grade one piece of text")
    c.add_argument("--grader", required=True, help=f"one of: {', '.join(sorted(BUILDERS))}")
    c.add_argument("--text", help="text to grade (default: stdin)")
    c.add_argument("--expected")
    c.add_argument("--needles", nargs="*")
    c.add_argument("--pattern")
    c.add_argument("--allowed", nargs="*")
    c.add_argument("--spec", help="JSON object merged over the flags, for graders with richer options")
    c.set_defaults(fn=cmd_check)

    r = sub.add_parser("run", help="grade a whole suite")
    r.add_argument("suite", help="suite JSON: {tasks:[…]} or a bare list")
    r.add_argument("--answers", help="JSON {task_id: answer} (default: stdin)")
    r.set_defaults(fn=cmd_run)

    args = p.parse_args(argv)
    try:
        return args.fn(args)
    except (ValueError, KeyError) as e:
        sys.stderr.write(f"gradecli: {e}\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
