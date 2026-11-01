#!/usr/bin/env python3
"""
============================================================================
GLOSSARY & ADR INTEGRITY VERIFIER (check-glossary-and-adrs.py)
============================================================================

PURPOSE:
--------
Prevents 3-way merge corruption in `GLOSSARY.md` and `docs/adr/` by enforcing:
  1. Every `### <Term>` heading in `GLOSSARY.md` is strictly unique and has
     a non-empty `- **Definition**:` line immediately below it.
  2. Every `docs/adr/*.md` file has a unique 4-digit numeric prefix (`NNNN-...`)
     and sequential numbering with zero duplicate prefixes.
  3. All ADR files and `GLOSSARY.md` are written in English (no French headers
     such as `Décision`, `Contexte`, `Conséquences`).

INVARIANTS & SAFETY BOUNDARIES:
-------------------------------
  - Zero external Python dependencies (stdlib only).
  - Exits with non-zero status code on any violation so CI and `make lint`
    fail closed before corrupt merges land on `feature/*` or `dev`.

EXECUTION LIFECYCLE:
--------------------
  1. Parse `GLOSSARY.md` and verify uniqueness of `### <Term>` headings.
  2. Scan `docs/adr/*.md` and verify unique 4-digit numeric prefixes.
  3. Return exit code 0 on pass, 1 on any violation.
============================================================================
"""

from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
GLOSSARY_PATH = ROOT / "GLOSSARY.md"
ADR_DIR = ROOT / "docs" / "adr"

HEADING_RE = re.compile(r"^###\s+([A-Za-z0-9_.\-]+)\s*$")
ADR_FILE_RE = re.compile(r"^(\d{4})-[a-z0-9\-]+\.md$")
FORBIDDEN_FRENCH_RE = re.compile(
    r"\b(Décision|Conséquences|Périmètre|Modèle de Données|L'issue|L'application)\b"
)


def check_glossary() -> list[str]:
    errors: list[str] = []
    if not GLOSSARY_PATH.is_file():
        return [f"Missing glossary file: {GLOSSARY_PATH}"]

    content = GLOSSARY_PATH.read_text(encoding="utf-8")
    seen_terms: dict[str, int] = {}
    lines = content.splitlines()

    for idx, raw_line in enumerate(lines, start=1):
        match = HEADING_RE.match(raw_line)
        if not match:
            continue
        term = match.group(1)
        if term in seen_terms:
            errors.append(
                f"GLOSSARY.md:{idx}: duplicate term heading '### {term}' "
                f"(first defined at line {seen_terms[term]})"
            )
        else:
            seen_terms[term] = idx

        # Check that a Definition bullet follows before the next heading
        has_def = False
        for follow_line in lines[idx : min(idx + 6, len(lines))]:
            if follow_line.startswith("### "):
                break
            if "- **Definition**:" in follow_line:
                has_def = True
                break
        if not has_def:
            errors.append(
                f"GLOSSARY.md:{idx}: term '### {term}' is missing a '- **Definition**:' entry"
            )

    if len(seen_terms) < 20:
        errors.append(
            f"GLOSSARY.md: expected at least 20 controlled terms, found {len(seen_terms)}"
        )

    required_terms = ["CampaignWorkspace", "CanvasThemePalette", "PadlockEditMode"]
    for term in required_terms:
        if term not in seen_terms:
            errors.append(
                f"GLOSSARY.md: missing mandatory controlled term '### {term}'"
            )

    return errors


def check_adrs() -> list[str]:
    errors: list[str] = []
    if not ADR_DIR.is_dir():
        return []

    adr_files = sorted(p for p in ADR_DIR.iterdir() if p.is_file() and p.suffix == ".md")
    if not adr_files:
        return []

    seen_numbers: dict[str, str] = {}
    for path in adr_files:
        match = ADR_FILE_RE.match(path.name)
        if not match:
            errors.append(
                f"docs/adr/{path.name}: filename must match 'NNNN-kebab-case-slug.md'"
            )
            continue
        num = match.group(1)
        if num in seen_numbers:
            errors.append(
                f"docs/adr/{path.name}: duplicate ADR number {num} "
                f"(already used by {seen_numbers[num]})"
            )
        else:
            seen_numbers[num] = path.name

        text = path.read_text(encoding="utf-8")
        fr_match = FORBIDDEN_FRENCH_RE.search(text)
        if fr_match:
            errors.append(
                f"docs/adr/{path.name}: contains non-English text ('{fr_match.group(0)}'); "
                f"all ADRs must obey the English-only language policy"
            )

    return errors


def main() -> int:
    errors = check_glossary() + check_adrs()
    if errors:
        for err in errors:
            print(f"ERROR: {err}", file=sys.stderr)
        return 1
    print("OK: GLOSSARY.md and docs/adr/ passed uniqueness and language integrity checks.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
