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
PATH_DOCS = [ROOT / "runs" / "README.md", ROOT / "README.md",
             ROOT / "FINDINGS.md", ROOT / "suites" / "README.md"]

# Any single-line JSON object literal MENTIONING a grader — including suite-task
# examples, where "grader" is not the first key. An extractor that only matched
# specs starting with "grader" found 2 of them and reported success, which is
# exactly the false confidence this script exists to prevent.
OBJ = re.compile(r'\{[^{}\n]*"grader"[^{}\n]*\}')


# A path inside a fenced command, including shell brace expansion:
#   runs/think/ll-high-r{2,3}.graded.json  ->  two real files
PATHISH = re.compile(r"(?<![\w/.-])((?:runs|suites|tools|skills|extensions|tests|scripts)/[\w./{},*-]+)")


def expand_braces(token: str) -> list[str]:
    m = re.search(r"\{([^{}]*)\}", token)
    if not m:
        return [token]
    out = []
    for part in m.group(1).split(","):
        out.extend(expand_braces(token[: m.start()] + part + token[m.end():]))
    return out


# A path that a command WRITES is not a claim that the file exists — it is the
# opposite. Anything following --out or a shell redirect is an output.
OUTPUT_CONTEXT = re.compile(r"(?:--out|--answers-out|>)\s+\S*$")


def check_paths() -> list[str]:
    """Every file a documented command names must exist.

    runs/README.md promises that each published number can be regenerated. A run
    file that gets renamed turns that promise into a command that errors, and
    nothing else in this repo would notice.
    """
    missing = []
    for doc in PATH_DOCS:
        if not doc.exists():
            continue
        text = doc.read_text()
        for m in PATHISH.finditer(text):
            raw = m.group(1)
            # Look at what precedes this path on its own line.
            line_start = text.rfind("\n", 0, m.start()) + 1
            if OUTPUT_CONTEXT.search(text[line_start:m.start()]):
                continue
            for path in expand_braces(raw):
                if "*" in path or "<" in path:
                    continue  # a placeholder, not a claim
                if not (ROOT / path).exists():
                    missing.append(f"{doc.name}: {path}")
    return missing


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
    missing = check_paths()
    for m in missing:
        print(f"missing file referenced by a documented command: {m}", file=sys.stderr)

    print(f"checked {checked} documented grader spec(s), {len(bad)} unbuildable; "
          f"{len(missing)} missing path(s)")
    if checked == 0:
        print("no specs found — the extractor is probably broken", file=sys.stderr)
        return 2
    return 1 if (bad or missing) else 0


if __name__ == "__main__":
    raise SystemExit(main())
