#!/usr/bin/env python3
"""Executable documentation check.

Every JSON grader spec printed in SKILL.md and README.md is run through gradecli.
Exit 2 from gradecli means the spec itself is malformed — a documented example
that cannot be built is a lie the reader finds out about at the worst moment.

This exists because the last documentation drift in this repo made every single
documented command "command not found", and nothing caught it until the package
was installed into a real Pi.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLI = ROOT / "skills" / "grade" / "scripts" / "gradecli.py"
DOCS = [ROOT / "skills" / "grade" / "SKILL.md", ROOT / "README.md"]

# Any single-line JSON object literal MENTIONING a grader — including suite-task
# examples, where "grader" is not the first key. An extractor that only matched
# specs starting with "grader" found 2 of them and reported success, which is
# exactly the false confidence this script exists to prevent.
OBJ = re.compile(r'\{[^{}\n]*"grader"[^{}\n]*\}')


def main() -> int:
    checked = 0
    bad: list[tuple[str, str, str]] = []
    for doc in DOCS:
        if not doc.exists():
            continue
        for raw in OBJ.findall(doc.read_text()):
            try:
                spec = json.loads(raw)
            except json.JSONDecodeError:
                continue  # prose that merely looks like JSON is not a claim
            if not isinstance(spec, dict) or "grader" not in spec:
                continue
            checked += 1
            r = subprocess.run(
                [sys.executable, str(CLI), "check", "--spec", raw, "--text", "probe"],
                capture_output=True, text=True,
            )
            # 0 pass / 1 fail are both fine — the probe text is arbitrary.
            # 2 means the SPEC is wrong, which is the thing being tested.
            if r.returncode == 2:
                bad.append((doc.name, raw, (r.stdout + r.stderr).strip().splitlines()[-1]))

    for name, raw, err in bad:
        print(f"{name}: unbuildable spec {raw}\n    {err}", file=sys.stderr)
    print(f"checked {checked} documented grader spec(s), {len(bad)} unbuildable")
    if checked == 0:
        print("no specs found — the extractor is probably broken", file=sys.stderr)
        return 2
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
