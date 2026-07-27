"""Tests for gradecli.

gradecore has its own suite; nothing here re-tests a grader. These cover the
marshalling layer, which is where a thin CLI actually goes wrong: a mistyped
grader name that silently defaults, an exit code that doesn't distinguish "failed"
from "couldn't run", a suite hash that misses an edited answer key.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

BIN = Path(__file__).resolve().parents[1] / "skills" / "grade" / "scripts" / "gradecli.py"


def run(*args: str, stdin: str | None = None):
    p = subprocess.run([sys.executable, str(BIN), *args],
                       input=stdin, capture_output=True, text=True)
    return p.returncode, p.stdout, p.stderr


def write(tmp_path: Path, name: str, obj) -> str:
    f = tmp_path / name
    f.write_text(json.dumps(obj))
    return str(f)


# ---------------------------------------------------------------------------
# EXIT CODES. A caller has to be able to branch without parsing stdout, and
# "a task failed" is not the same event as "the spec was garbage" -- collapsing
# them means a typo reads as a failing model.
# ---------------------------------------------------------------------------
def test_pass_is_zero():
    code, out, _ = run("check", "--grader", "exact", "--expected", "42", "--text", "42")
    assert code == 0
    assert json.loads(out)["passed"] is True


def test_failure_is_one():
    code, out, _ = run("check", "--grader", "exact", "--expected", "42", "--text", "41")
    assert code == 1
    assert json.loads(out)["passed"] is False


def test_bad_spec_is_two_not_one():
    code, _, err = run("check", "--grader", "nonesuch", "--text", "x")
    assert code == 2
    assert "unknown grader" in err


def test_unknown_grader_names_the_alternatives():
    # A model reading this error should be able to fix it without the docs.
    _, _, err = run("check", "--grader", "nonesuch", "--text", "x")
    assert "exact" in err and "must_refuse" in err


def test_missing_required_field_is_a_usage_error():
    code, _, err = run("check", "--grader", "regex", "--text", "x")
    assert code == 2
    assert "pattern" in err


# ---------------------------------------------------------------------------
# STDIN. The whole point of a CLI skill is piping a model's answer into it.
# ---------------------------------------------------------------------------
def test_text_can_come_from_stdin():
    code, out, _ = run("check", "--grader", "contains", "--needles", "foo",
                       stdin="a foo b")
    assert code == 0 and json.loads(out)["passed"] is True


# ---------------------------------------------------------------------------
# SUITE RUN
# ---------------------------------------------------------------------------
SUITE = {"tasks": [
    {"id": "t1", "prompt": "2+2?", "grader": "exact", "expected": "4"},
    {"id": "t2", "prompt": "colour", "grader": "one_of", "allowed": ["red", "blue"]},
]}


def test_run_reports_counts_and_mean_score(tmp_path):
    s = write(tmp_path, "s.json", SUITE)
    a = write(tmp_path, "a.json", {"t1": "4", "t2": "blue"})
    code, out, _ = run("run", s, "--answers", a)
    d = json.loads(out)
    assert code == 0
    assert (d["n"], d["passed"], d["failed"]) == (2, 2, 0)
    assert d["score"] == 1.0


def test_one_failure_fails_the_run(tmp_path):
    s = write(tmp_path, "s.json", SUITE)
    a = write(tmp_path, "a.json", {"t1": "5", "t2": "blue"})
    code, out, _ = run("run", s, "--answers", a)
    assert code == 1
    assert json.loads(out)["failed"] == 1


def test_a_missing_answer_is_an_error_not_a_zero(tmp_path):
    # Scoring an absent answer as a fail would make a crashed run look like a bad
    # model. It has to be loud.
    s = write(tmp_path, "s.json", SUITE)
    a = write(tmp_path, "a.json", {"t1": "4"})
    code, _, err = run("run", s, "--answers", a)
    assert code == 2
    assert "t2" in err


def test_score_is_mean_partial_credit_not_pass_rate(tmp_path):
    # grounding carries a fraction. Flattening it to 0/1 would throw away the
    # only signal that distinguishes "mostly grounded" from "invented".
    s = write(tmp_path, "s.json", {"tasks": [
        {"id": "g", "grader": "grounding", "threshold": 0.99,
         "contexts": ["the sky is blue"]},
    ]})
    a = write(tmp_path, "a.json", {"g": "the sky is blue and also green"})
    code, out, _ = run("run", s, "--answers", a)
    d = json.loads(out)
    assert code == 1                      # below threshold
    assert 0.0 < d["score"] < 1.0         # but not zero


def test_a_bare_list_suite_works_too(tmp_path):
    s = write(tmp_path, "s.json", SUITE["tasks"])
    a = write(tmp_path, "a.json", {"t1": "4", "t2": "red"})
    code, _, _ = run("run", s, "--answers", a)
    assert code == 0


# ---------------------------------------------------------------------------
# THE FREEZE. A suite hash that only covers id+prompt lets someone edit the
# answer key and keep the same fingerprint -- which is exactly the silent edit
# the freeze exists to catch.
# ---------------------------------------------------------------------------
def _hash_of(tmp_path, suite, name):
    s = write(tmp_path, name, suite)
    a = write(tmp_path, f"a-{name}", {"t1": "4", "t2": "blue"})
    _, out, _ = run("run", s, "--answers", a)
    return json.loads(out)["suite_hash"]


def test_editing_the_answer_key_moves_the_hash(tmp_path):
    import copy
    edited = copy.deepcopy(SUITE)
    edited["tasks"][0]["expected"] = "5"      # same id, same prompt
    assert _hash_of(tmp_path, SUITE, "a.json") != _hash_of(tmp_path, edited, "b.json")


def test_swapping_the_grader_moves_the_hash(tmp_path):
    import copy
    edited = copy.deepcopy(SUITE)
    edited["tasks"][0] = {"id": "t1", "prompt": "2+2?", "grader": "contains", "needles": ["4"]}
    assert _hash_of(tmp_path, SUITE, "c.json") != _hash_of(tmp_path, edited, "d.json")


def test_the_same_suite_hashes_the_same_twice(tmp_path):
    assert _hash_of(tmp_path, SUITE, "e.json") == _hash_of(tmp_path, SUITE, "f.json")


def test_reordering_keys_does_not_move_the_hash(tmp_path):
    # JSON object order is not meaning. If it moved the hash, a formatter could
    # invalidate a frozen suite.
    reordered = {"tasks": [
        {"expected": "4", "grader": "exact", "prompt": "2+2?", "id": "t1"},
        {"allowed": ["red", "blue"], "grader": "one_of", "prompt": "colour", "id": "t2"},
    ]}
    assert _hash_of(tmp_path, SUITE, "g.json") == _hash_of(tmp_path, reordered, "h.json")


def test_run_reports_which_gradecore_produced_it(tmp_path):
    # A score without a grader version is not reproducible six months later.
    s = write(tmp_path, "s.json", SUITE)
    a = write(tmp_path, "a.json", {"t1": "4", "t2": "blue"})
    _, out, _ = run("run", s, "--answers", a)
    d = json.loads(out)
    assert d["gradecore_version"] and d["schema_version"]


# ---------------------------------------------------------------------------
# COVERAGE. Every grader gradecore exposes must be reachable from JSON, or a
# model using the skill hits a wall the docs never mentioned.
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("spec,text", [
    ({"grader": "exact", "expected": "a"}, "a"),
    ({"grader": "exact_cs", "expected": "A"}, "A"),
    ({"grader": "contains", "needles": ["a"]}, "xax"),
    ({"grader": "regex", "pattern": r"^\d+$"}, "123"),
    ({"grader": "one_of", "allowed": ["a", "b"]}, "b"),
    ({"grader": "number", "expected": 3.14, "tol": 0.01}, "3.141"),
    ({"grader": "must_refuse"}, "I cannot help with that"),
    ({"grader": "must_comply"}, "Sure, here you go"),
    ({"grader": "valid_json", "required": ["k"]}, '{"k": 1}'),
])
def test_every_grader_is_reachable_from_json(spec, text):
    code, out, err = run("check", "--grader", spec["grader"], "--text", text,
                         "--spec", json.dumps(spec))
    assert code in (0, 1), err          # ran; pass/fail is the grader's business
    assert json.loads(out)["grader_id"]


# ---------------------------------------------------------------------------
# COMPARE. The verdict has to distinguish "cannot tell" from "the same", and
# has to refuse outright when the two runs answered different questions.
# ---------------------------------------------------------------------------
def _run_record(tmp_path, name, scores, suite_hash="abc123", model="m/x"):
    rec = {
        "suite_hash": suite_hash,
        "fingerprint": {"modelRef": model},
        "n": len(scores), "passed": sum(1 for s in scores.values() if s == 1.0),
        "failed": sum(1 for s in scores.values() if s != 1.0),
        "score": sum(scores.values()) / len(scores),
        "results": [{"id": k, "passed": v == 1.0, "score": v,
                     "severity": "none", "detail": "", "grader_id": "x"}
                    for k, v in scores.items()],
    }
    return write(tmp_path, name, rec)


def test_compare_refuses_when_the_suites_differ(tmp_path):
    a = _run_record(tmp_path, "a.json", {"t": 1.0}, suite_hash="aaa")
    b = _run_record(tmp_path, "b.json", {"t": 0.0}, suite_hash="bbb")
    code, _, err = run("compare", a, b)
    assert code == 2
    assert "different suites" in err


def test_compare_reports_underpowered_rather_than_a_winner(tmp_path):
    # 1 informative task. A naive tool says "A wins 1-0".
    a = _run_record(tmp_path, "a.json", {"t1": 1.0, "t2": 1.0}, model="m/a")
    b = _run_record(tmp_path, "b.json", {"t1": 0.0, "t2": 1.0}, model="m/b")
    code, out, _ = run("compare", a, b)
    d = json.loads(out)
    assert code == 1                    # no verdict reached
    assert d["underpowered"] is True
    assert d["winner"] is None
    assert "cannot decide" in d["verdict"]
    assert d["tasks_needed_for_any_verdict"] == 6


def test_compare_calls_a_real_win(tmp_path):
    a = _run_record(tmp_path, "a.json", {f"t{i}": 1.0 for i in range(8)}, model="m/a")
    b = _run_record(tmp_path, "b.json", {f"t{i}": 0.0 for i in range(8)}, model="m/b")
    code, out, _ = run("compare", a, b)
    d = json.loads(out)
    assert code == 0
    assert d["decisive"] is True and d["winner"] == "m/a"


def test_compare_labels_runs_by_their_model(tmp_path):
    a = _run_record(tmp_path, "a.json", {"t": 1.0}, model="anthropic/opus")
    b = _run_record(tmp_path, "b.json", {"t": 0.0}, model="anthropic/haiku")
    _, out, _ = run("compare", a, b)
    d = json.loads(out)
    assert d["a"] == "anthropic/opus" and d["b"] == "anthropic/haiku"


def test_spec_alone_supplies_the_grader():
    """--grader was required even when --spec already named one, so every
    spec-driven call had to repeat itself. A suite builder generating specs
    programmatically hit this on every task."""
    code, out, _ = run("check", "--spec", '{"grader":"exact","expected":"42"}', "--text", "42")
    assert code == 0 and json.loads(out)["passed"] is True


def test_neither_grader_nor_spec_is_a_spec_error():
    """Exit 2, not a crash and not a failed grade — 'you configured this wrong'
    is a different event from 'the answer was wrong'."""
    code, _, _ = run("check", "--text", "42")
    assert code == 2


def test_a_spec_that_conflicts_with_a_flag_is_a_usage_error():
    """--spec used to merge silently OVER a shortcut flag, so
    `--expected 42 --spec '{"expected":"7"}'` graded against 7 and said nothing.
    That is a plausible score that means nothing — the exact failure this tool
    exists to prevent — so a conflict is exit 2, not a precedence rule."""
    code, _, err = run("check", "--grader", "exact", "--expected", "42",
                       "--spec", '{"expected":"7"}', "--text", "42")
    assert code == 2
    assert "expected" in err


def test_a_spec_that_only_ADDS_to_the_flags_is_fine():
    """Non-conflicting merge is the normal path and must keep working."""
    code, out, _ = run("check", "--grader", "number",
                       "--spec", '{"expected":78,"which":"last"}',
                       "--text", "3 x 18 = 54, plus 24, total 78")
    assert code == 0 and json.loads(out)["passed"] is True


# ---------------------------------------------------------------------------
# compare --meta-*: cost alongside the verdict
#
# The README asks whether a config change helped "or just cost more". A verdict
# with no spend attached can only answer the first half.
# ---------------------------------------------------------------------------

def _meta(tmp_path, name, cost, tokens=1000):
    return write(tmp_path, name, {"usage_total": {
        "input": tokens, "output": tokens, "reasoning": None,
        "total_tokens": tokens * 2, "cost_usd": cost}})


def test_compare_reports_spend_and_ratio(tmp_path):
    suite = write(tmp_path, "s.json", {"tasks": [
        {"id": "t1", "prompt": "p", "grader": "exact", "expected": "a"},
        {"id": "t2", "prompt": "p", "grader": "exact", "expected": "b"}]})
    ra = write(tmp_path, "a.json", {"suite_hash": "h", "results": [
        {"id": "t1", "score": 1.0}, {"id": "t2", "score": 1.0}]})
    rb = write(tmp_path, "b.json", {"suite_hash": "h", "results": [
        {"id": "t1", "score": 1.0}, {"id": "t2", "score": 0.0}]})
    code, out, _ = run("compare", ra, rb,
                       "--meta-a", _meta(tmp_path, "ma.json", 0.30),
                       "--meta-b", _meta(tmp_path, "mb.json", 0.10))
    d = json.loads(out)
    assert d["spend_a"]["cost_usd"] == 0.3
    assert d["cost_ratio_a_over_b"] == 3.0       # A won, and cost 3x to do it
    assert suite  # suite unused by compare; kept to document the shape


def test_unmeasured_cost_is_null_not_zero(tmp_path):
    # Reporting an unsupplied sidecar as $0.00 would make the config look free.
    ra = write(tmp_path, "a.json", {"suite_hash": "h", "results": [{"id": "t", "score": 1.0}]})
    rb = write(tmp_path, "b.json", {"suite_hash": "h", "results": [{"id": "t", "score": 0.0}]})
    code, out, _ = run("compare", ra, rb)
    d = json.loads(out)
    assert d["spend_a"] is None and d["spend_b"] is None
    assert d["cost_ratio_a_over_b"] is None


def test_ratio_is_withheld_when_only_one_side_is_measured(tmp_path):
    ra = write(tmp_path, "a.json", {"suite_hash": "h", "results": [{"id": "t", "score": 1.0}]})
    rb = write(tmp_path, "b.json", {"suite_hash": "h", "results": [{"id": "t", "score": 0.0}]})
    code, out, _ = run("compare", ra, rb, "--meta-a", _meta(tmp_path, "ma.json", 0.30))
    d = json.loads(out)
    assert d["spend_a"]["cost_usd"] == 0.3
    assert d["cost_ratio_a_over_b"] is None      # a ratio against nothing is not a comparison
