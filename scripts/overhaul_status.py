#!/usr/bin/env python3
"""State accessor for the overhaul driver loop.

STATUS.json is the queue that survives between context windows. The driver owns
it exclusively -- block agents are told not to touch it, so a block cannot mark
itself done.
"""
import json
import sys
from pathlib import Path

STATUS = Path(__file__).resolve().parent.parent / "docs/plans/overhaul/STATUS.json"

RUNNABLE = {"todo"}
TERMINAL = {"done", "in-review"}


def load():
    return json.loads(STATUS.read_text())


def save(data):
    STATUS.write_text(json.dumps(data, indent=4) + "\n")


def find(data, block_id):
    for b in data["blocks"]:
        if b["id"] == block_id:
            return b
    return None


def cmd_next(_args):
    """First runnable block, honouring blockedBy.

    DRY_SKIP is a comma-separated list of ids to pretend are already done. The
    driver sets it during --dry-run, where nothing is ever marked done and this
    would otherwise return the same block forever.
    """
    import os
    skip = {s for s in os.environ.get("DRY_SKIP", "").split(",") if s}
    data = load()
    done = {b["id"] for b in data["blocks"] if b.get("status") in TERMINAL} | skip
    for b in data["blocks"]:
        if b.get("status") not in RUNNABLE or b["id"] in skip:
            continue
        if b.get("blockedBy"):
            continue  # external blocker, never auto-run
        deps = b.get("dependsOn", [])
        if any(d not in done for d in deps):
            continue
        print(b["id"])
        return 0
    return 0


def cmd_runnable(args):
    data = load()
    b = find(data, args[0])
    if b is None or b.get("status") not in RUNNABLE or b.get("blockedBy"):
        return 1
    print(b["id"])
    return 0


def cmd_title(args):
    b = find(load(), args[0])
    print(b["title"] if b else "")
    return 0


def cmd_donecmd(args):
    b = find(load(), args[0])
    print((b or {}).get("doneWhenCmd", ""))
    return 0


def cmd_mark(args):
    block_id, status = args[0], args[1]
    if "--dry" in args:
        return 0
    data = load()
    b = find(data, block_id)
    if b is None:
        print(f"no such block: {block_id}", file=sys.stderr)
        return 1
    b["status"] = status
    note = Path(f"docs/plans/overhaul/notes/block-{block_id}.md")
    if status == "done" and note.exists():
        b["handoffNote"] = str(note)
    save(data)
    return 0


def cmd_report(_args):
    data = load()
    width = max(len(b["title"]) for b in data["blocks"])
    icon = {
        "done": "✓", "in-review": "○", "todo": " ",
        "in-progress": "…", "stuck": "✗", "blocked": "⛔",
    }
    for b in data["blocks"]:
        st = b.get("status", "todo")
        print(f"  {icon.get(st, '?')}  {b['id']:<5} {b['title']:<{width}}  {st}")
    counts = {}
    for b in data["blocks"]:
        counts[b.get("status", "todo")] = counts.get(b.get("status", "todo"), 0) + 1
    print("\n  " + ", ".join(f"{v} {k}" for k, v in sorted(counts.items())))
    return 0


COMMANDS = {
    "next": cmd_next, "runnable": cmd_runnable, "title": cmd_title,
    "donecmd": cmd_donecmd, "mark": cmd_mark, "report": cmd_report,
}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(f"usage: {sys.argv[0]} {{{'|'.join(COMMANDS)}}} [args]", file=sys.stderr)
        sys.exit(3)
    sys.exit(COMMANDS[sys.argv[1]](sys.argv[2:]))
