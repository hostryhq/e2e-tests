#!/usr/bin/env python3
"""Archive one soak run in the test-results repo (test-results-archive skill): runs/<YYYY>/<date>/<run-id>/
summary.json, report.md, artifacts/ and one INDEX.md line. Append-only: refuses to write over an existing run.

  archive.py --result run.result.json --repo <test-results> --commits commits.json --started ISO --finished ISO \
             --label "soak seed 1 settle" --variant "billing patched" --command "..." --artifact file [--artifact file ...]
"""
import argparse
import datetime
import gzip
import json
import os
import shutil
import sys


def short(sha):
    return sha[:7]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--result", required=True)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--commits", required=True)
    ap.add_argument("--started", required=True)
    ap.add_argument("--finished", required=True)
    ap.add_argument("--label", required=True)
    ap.add_argument("--variant", default="")
    ap.add_argument("--command", required=True)
    ap.add_argument("--environment-note", default="")
    ap.add_argument("--artifact", action="append", default=[])
    ap.add_argument("--findings", default="")
    a = ap.parse_args()

    r = json.load(open(a.result))
    commits = json.load(open(a.commits))
    claims = r["claims"]
    passed = sum(1 for c in claims if c["status"] == "pass")
    failed = sum(1 for c in claims if c["status"] == "fail")
    skipped = sum(1 for c in claims if c["status"] == "not_run")
    status = "pass" if failed == 0 and skipped == 0 else ("fail" if failed else "partial")
    st = datetime.datetime.fromisoformat(a.started.replace("Z", "+00:00"))
    primary = commits["e2e-tests"]["sha"] if isinstance(commits["e2e-tests"], dict) else commits["e2e-tests"]
    run_id = f"{st:%H%M%S}-e2e-{short(primary)}"
    day = f"{st:%Y-%m-%d}"
    rel = f"runs/{st:%Y}/{day}/{run_id}"
    d = os.path.join(a.repo, rel)
    if os.path.exists(d):
        sys.exit(f"refusing to overwrite {rel}")
    os.makedirs(os.path.join(d, "artifacts"))

    for p in a.artifact:
        dst = os.path.join(d, "artifacts", os.path.basename(p))
        if p.endswith((".gz",)) or os.path.getsize(p) < 20_000:
            shutil.copy(p, dst)
        else:
            with open(p, "rb") as f, gzip.open(dst + ".gz", "wb") as g:
                shutil.copyfileobj(f, g)

    summary = {
        "run_id": run_id,
        "suite": "e2e",
        "target": f"ADR-0014 R11 simulated trading-day soak ({a.label}{'; ' + a.variant if a.variant else ''})",
        "commit": primary,
        "environment": "local",
        "started_at": a.started,
        "finished_at": a.finished,
        "passed": passed,
        "failed": failed,
        "skipped": skipped,
        "status": status,
        "baseline_compared": False,
        "regressions": [],
        "triggered_by": "manual",
        "commits": commits,
        "command": a.command,
        "seed": r["seed"],
        "number_at": r["mode"],
        "counts_are": "claims (T1 to T13, X1 no duplicate ops, X2 erasure, X3 cloud restore, S1 to S7 review scenarios); skipped = not run",
        "claims": {c["id"]: c["status"] for c in claims},
        "report": f"{rel}/report.md",
    }
    json.dump(summary, open(os.path.join(d, "summary.json"), "w"), indent=2)
    open(os.path.join(d, "summary.json"), "a").write("\n")

    L = []
    L.append(f"# ADR-0014 R11 trading-day soak: {a.label}")
    L.append("")
    L.append(f"Run `{run_id}`, {day}. {a.environment_note or 'Local developer machine (WSL2 Linux), full Phase 2 stack as local processes, Postgres 17 and NATS 2.15.3 in Docker under their own compose project and ports; nothing outside this machine is contacted.'}")
    if a.variant:
        L.append(f"Variant: **{a.variant}**.")
    L.append(f"Command: `{a.command}`. Wall time {r['wall_ms'] / 1000:.0f} s (the simulated day {r['day_wall_ms'] / 1000:.0f} s, reconnect convergence {r['reconnect_wall_ms'] / 1000:.1f} s).")
    L.append(f"Result: **{passed} claims passed, {failed} failed, {skipped} not run** (status `{status}`). Seed {r['seed']}, `number_at={r['mode']}`, business date {r['date']}.")
    L.append("")
    L.append("## Repositories (SHAs)")
    L.append("")
    L.append("| repo | branch | SHA |")
    L.append("|---|---|---|")
    for k, v in commits.items():
        if isinstance(v, dict):
            L.append(f"| {k} | {v.get('branch', '')} | `{v['sha']}`{' (' + v['note'] + ')' if v.get('note') else ''} |")
    L.append("")
    L.append("## Claims")
    L.append("")
    L.append("| claim | result | first failing check |")
    L.append("|---|---|---|")
    for c in claims:
        first = c["failures"][0].replace("|", "/")[:220] if c["failures"] else ""
        L.append(f"| {c['id']} {c['name']} | {c['status'].upper()} | {first} |")
    L.append("")
    L.append("## Evidence and failures per claim")
    for c in claims:
        L.append("")
        L.append(f"### {c['id']} {c['name']}: {c['status'].upper()}")
        for e in c["evidence"]:
            L.append(f"- pass: {e}")
        for e in c["failures"]:
            L.append(f"- **fail:** {e}")
    L.append("")
    L.append("## Run facts")
    f = r["facts"]
    L.append(f"- Script steps: {f['steps_total']} run, {len(f['steps_failed'])} failed: {json.dumps(f['steps_failed'])}")
    L.append(f"- Hub stops {f['hubKills']} (disk wipes {f['hubWipes']}), device restarts {f['restarts']}, lost push answers {f['lostAcks']}, approvals {f['approvals']}, bills by device {json.dumps(f['bills_by_device'])}")
    L.append(f"- Offline Z: {json.dumps(f['z'])}; second close on the partitioned counter: {json.dumps(f['z2'])}")
    L.append(f"- Gateway ops by outcome: {json.dumps(r['gateway_ops'])}; parked events billing/orders: {json.dumps(r['parked'])}")
    L.append(f"- Billing exceptions: {json.dumps(r['extra'].get('exceptions', {}).get('billing'))}; orders exceptions: {json.dumps(r['extra'].get('exceptions', {}).get('orders_counts'))}")
    if r["extra"].get("restore"):
        L.append(f"- Cloud restore: {json.dumps(r['extra']['restore'])}")
    L.append("")
    L.append("## Timeline")
    for e in f["events"]:
        L.append(f"- {e}")
    if a.findings:
        L.append("")
        L.append(f"Findings drawn from this and the other runs: `{a.findings}`.")
    L.append("")
    L.append("## Artifacts")
    L.append("")
    for p in a.artifact:
        L.append(f"- `artifacts/{os.path.basename(p)}`")
    open(os.path.join(d, "report.md"), "w").write("\n".join(L) + "\n")

    idx = os.path.join(a.repo, "INDEX.md")
    lines = open(idx).read().split("\n")
    entry = f"- {day} {run_id} | e2e | soak {a.label}{' (' + a.variant + ')' if a.variant else ''} | {status} | pass {passed} fail {failed} skip {skipped} | R11 soak T1-T13, X1-X3, S1-S7 | {rel}/report.md"
    at = next(i for i, l in enumerate(lines) if l.startswith("- "))
    lines.insert(at, entry)
    open(idx, "w").write("\n".join(lines))
    print(rel)


main()
