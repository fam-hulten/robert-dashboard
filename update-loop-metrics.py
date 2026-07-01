#!/usr/bin/env python3
"""Rewrite update_loop_metrics to add machine-readable METRICS section."""

import os
import re
from datetime import datetime
from collections import defaultdict

WORKSPACE = os.environ.get("WORKSPACE", "/home/robert/.openclaw/workspace")
LOG_DIR = os.path.join(WORKSPACE, "logs")
LOOP_METRICS = os.path.join(WORKSPACE, "metrics/loop-metrics.md")

LOG_FILES = {
    "planning": "planning-cron.log",
    "implementation": "implementation-cron.log",
    "ai-review": "ai-review-cron.log",
    "pr-review": "pr-review-cron.log",
    "create-pr": "create-pr-cron.log",
    "post-merge": "post-merge-cron.log",
    "fix-pr": "fix-pr-cron.log",
}

START_RE = re.compile(r"^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] START #(\d+)\s+(.+)$")
DONE_RE = re.compile(r"^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] DONE #(\d+)\s+(.+)$")
ERROR_RE = re.compile(r"^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] ERROR #(\d+)\s*:\s*(.+)$")
SKIP_RE = re.compile(r"^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] SKIP #(\d+)\s+(.+)$")
HOLD_RE = re.compile(r"^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] (HOLD|BLOCKED) #(\d+)\s+(.+)$")
ISSUE_RE = re.compile(r"^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] ISSUE #(\d+)\s*:\s*(.+)$")
NOTHING_RE = re.compile(r"^\[(?:\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] (?:PLANNING-?PICK|AI REVIEW PICK|REVIEW):? ?NOTHING")

def parse_log(log_path):
    if not os.path.exists(log_path):
        return []
    entries = []
    with open(log_path) as f:
        for line in f:
            line = line.rstrip()
            if "LOG CREATED" in line or NOTHING_RE.match(line):
                continue
            if m := START_RE.match(line):
                entries.append({"type": "START", "date": m.group(1), "issue": m.group(2), "repo": m.group(3).strip(), "raw": line})
            elif m := DONE_RE.match(line):
                entries.append({"type": "DONE", "date": m.group(1), "issue": m.group(2), "repo": m.group(3).strip(), "raw": line})
            elif m := ERROR_RE.match(line):
                entries.append({"type": "ERROR", "date": m.group(1), "issue": m.group(2), "repo": m.group(3).strip(), "raw": line, "error": m.group(3).strip()})
            elif m := SKIP_RE.match(line):
                entries.append({"type": "SKIP", "date": m.group(1), "issue": m.group(2), "repo": m.group(3).strip(), "raw": line})
            elif m := HOLD_RE.match(line):
                entries.append({"type": m.group(2), "date": m.group(1), "issue": m.group(3), "repo": m.group(4).strip(), "raw": line})
            elif m := ISSUE_RE.match(line):
                entries.append({"type": "ISSUE", "date": m.group(1), "issue": m.group(2), "repo": "", "raw": line, "note": m.group(3).strip()})
    return entries

def update_loop_metrics(all_entries):
    """Update loop-metrics.md with parsed entries + machine-readable METRICS section."""
    today = datetime.now().strftime("%Y-%m-%d")

    by_issue = defaultdict(lambda: {"repo": "", "entries": []})
    for e in all_entries:
        issue = e["issue"]
        if e.get("repo"):
            by_issue[issue]["repo"] = e["repo"]
        by_issue[issue]["entries"].append(e)

    sorted_issues = sorted(by_issue.items(), key=lambda x: x[1]["entries"][-1]["date"] if x[1]["entries"] else "", reverse=True)

    # Calculate aggregate metrics from Issue Summary
    total_issues = len(sorted_issues)
    quick_sessions = 0   # issues: starts <= 2 AND got at least 1 completion
    hard_sessions = 0     # issues: started 4+ times (stuck/iterating a lot)
    progression_signals = []  # issues: starts >= 4 AND completions < starts (stuck)

    for issue, data in sorted_issues:
        entries = data["entries"]
        starts = sum(1 for e in entries if e["type"] == "START")
        dones = sum(1 for e in entries if e["type"] == "DONE")
        errors = sum(1 for e in entries if e["type"] == "ERROR")
        skips = sum(1 for e in entries if e["type"] == "SKIP")

        if starts <= 2 and dones >= 1:
            quick_sessions += 1
        if starts >= 4:
            hard_sessions += 1
        if starts >= 4 and dones < starts:
            progression_signals.append({
                "issue": issue,
                "repo": data["repo"],
                "starts": starts,
                "completions": dones,
                "last_date": entries[-1]["date"][:10] if entries else ""
            })

    # Build new content
    lines = []
    lines.append("# Loop Metrics — Robert's Workflow")
    lines.append("")
    lines.append(f"*Last updated: {today} by update-loop-metrics.py*")
    lines.append("")
    lines.append("<!-- METRICS: quickSessions={} hardSessions={} totalIssues={} -->".format(
        quick_sessions, hard_sessions, total_issues))
    lines.append("")
    lines.append("*Tracks iteration counts and progression signals for issues in the development pipeline.*")
    lines.append("")
    lines.append("## Purpose")
    lines.append("")
    lines.append("This file logs:")
    lines.append("- Number of OpenCode sessions per issue per workflow step")
    lines.append("- Progression signals (4+ sessions without meaningful progress → flagged)")
    lines.append("- Failures captured during hot-capture (plan-feature, implement-feature, review-feature)")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## Issue Summary")
    lines.append("")
    lines.append(f"| Date | Issue | Repo | Starts | Completions | Errors | Skips |")
    lines.append("|------|-------|------|--------|-------------|--------|-------|")
    for issue, data in sorted_issues:
        entries = data["entries"]
        starts = sum(1 for e in entries if e["type"] == "START")
        dones = sum(1 for e in entries if e["type"] == "DONE")
        errors = sum(1 for e in entries if e["type"] == "ERROR")
        skips = sum(1 for e in entries if e["type"] == "SKIP")
        last_date = entries[-1]["date"][:16] if entries else ""
        repo_short = data["repo"][:25] if data["repo"] else "—"
        lines.append(f"| {last_date} | #{issue} | {repo_short} | {starts} | {dones} | {errors} | {skips} |")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## Session Detail")
    lines.append("")
    for issue, data in sorted_issues[:20]:
        repo = data["repo"]
        lines.append(f"### Issue #{issue} — {repo}")
        for e in data["entries"][-5:]:
            date_short = e["date"][5:]
            if e["type"] == "START":
                lines.append(f"- {date_short}: Started")
            elif e["type"] == "DONE":
                lines.append(f"- {date_short}: ✓ Done")
            elif e["type"] == "ERROR":
                err_short = e.get("error", "")[:80]
                lines.append(f"- {date_short}: ✗ Error — {err_short}")
            elif e["type"] == "SKIP":
                lines.append(f"- {date_short}: ⊘ Skipped")
            elif e["type"] in ("HOLD", "BLOCKED"):
                lines.append(f"- {date_short}: ⏸ {e['type']}")
        lines.append("")

    lines.append("---")
    lines.append("")
    lines.append("## Progression Signals")
    lines.append("")
    if progression_signals:
        lines.append(f"| Date | Issue | Repo | Starts | Completions |")
        lines.append("|------|-------|------|--------|-------------|")
        for sig in progression_signals[:10]:
            repo_short = sig["repo"][:25] if sig["repo"] else "—"
            lines.append(f"| {sig['last_date']} | #{sig['issue']} | {repo_short} | {sig['starts']} | {sig['completions']} |")
    else:
        lines.append("No progression signals yet")
    lines.append("")

    content = "\n".join(lines) + "\n"
    with open(LOOP_METRICS, "w") as f:
        f.write(content)
    print(f"Updated {LOOP_METRICS} ({total_issues} issues, {quick_sessions} quick, {hard_sessions} hard)")

    # Also update failure log
    update_failure_log(all_entries)

def update_failure_log(all_entries):
    """Append new failures to failure-mode-log.md from ERROR entries."""
    today = datetime.now().strftime("%Y-%m-%d")
    FAILURE_LOG = os.path.join(WORKSPACE, "code-standards/failure-mode-log.md")

    KNOWN_FAILURE_PATTERNS = {
        "OpenCode API key invalid": "API key authentication failure",
        "OpenCode failed": "OpenCode execution failure",
        "OpenCode binary": "OpenCode binary crash",
        "GitHub API rate limit": "GitHub API rate limit",
        "session_message.seq": "OpenCode session DB failure",
        "unexpected server error": "OpenCode unexpected server error",
        "Bus error": "OpenCode Bus error",
        "K.includes is not a function": "OpenCode JS runtime error",
        "timeout": "Script/command timeout",
    }

    failures = []
    for e in all_entries:
        if e["type"] != "ERROR":
            continue
        error_text = e.get("error", "")
        if "already" in error_text.lower() or "stale" in error_text.lower():
            continue
        if "false " in error_text.lower():
            continue
        for pattern, name in KNOWN_FAILURE_PATTERNS.items():
            if pattern.lower() in error_text.lower():
                failures.append({
                    "date": e["date"][:10],
                    "issue": e["issue"],
                    "repo": e["repo"],
                    "pattern": name,
                    "error": error_text[:120],
                })
                break

    if not failures:
        print("No new failures to log")
        return

    existing = set()
    if os.path.exists(FAILURE_LOG):
        with open(FAILURE_LOG) as f:
            content = f.read()
            for line in content.split("\n"):
                m = re.match(r"\| (\d{4}-\d{2}-\d{2}) \| #(\d+) \| (.+?) \|", line)
                if m:
                    existing.add((m.group(1), m.group(2), m.group(3).strip()))

    new_failures = [f for f in failures if (f["date"], f["issue"], f["pattern"]) not in existing]

    if not new_failures:
        print("All failures already logged")
        return

    rows = [f"| {f['date']} | #{f['issue']} | {f['pattern']} | GENERIC | cron-log | NEW | Medium | {f['error'][:80]} |" for f in new_failures]

    with open(FAILURE_LOG) as f:
        content = f.read()
    if "\n| " in content:
        content = content.rstrip() + "\n" + "\n".join(rows) + "\n"
    else:
        content += "\n".join(rows) + "\n"
    with open(FAILURE_LOG, "w") as f:
        f.write(content)
    print(f"Appended {len(new_failures)} failures to {FAILURE_LOG}")

def main():
    all_entries = []
    for step, filename in LOG_FILES.items():
        log_path = os.path.join(LOG_DIR, filename)
        entries = parse_log(log_path)
        for e in entries:
            e["step"] = step
        all_entries.extend(entries)

    update_loop_metrics(all_entries)

if __name__ == "__main__":
    main()
