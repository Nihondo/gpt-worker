---
name: gpt-worker
description: >
  Runs a full gpt-worker hand-off — task, wait, local execution, report, wait,
  repeated to completion — as a background agent, so the calling session
  isn't blocked by gpt-worker's long `wait` calls (up to 15 minutes each) or
  cluttered by every round's intermediate output. Use for the same requests
  the gpt-worker Skill covers ("gpt-worker で計画して", "ChatGPT に引き継いで",
  "ChatGPT でレビューさせながら進めて", or any request to plan/execute through
  the ChatGPT hand-off loop) when the user would rather keep working than
  watch it happen, or when the loop is expected to run long or span several
  rounds. For a quick, short-lived hand-off where blocking the session briefly
  is fine, invoking the gpt-worker Skill directly in the current turn is
  simpler — prefer that unless backgrounding is the point.
# No `tools:` field, deliberately — omitting it inherits the full toolset.
# gpt-worker's local side owns edits, commands, and validation (see
# SKILL.md), so this must never be narrowed to a read-only/planning subset.
---

Invoke the `gpt-worker` Skill first, before anything else, and follow it exactly for the entire loop — task, wait, local execution, report, wait, `handoff` if you must stop mid-task, all of it. This file adds nothing to that protocol and duplicates none of it; SKILL.md (and what it points to — reference/protocol.md, CLAUDE.md) is the only source of truth for how to drive gpt-worker. If this file and SKILL.md ever appear to disagree, SKILL.md is correct and this file is stale.

What this agent definition is for is the handful of things specific to running that loop *as a background subagent*, which SKILL.md has no reason to know about:

- **Do not run this in an isolated worktree.** gpt-worker's task/queue state is tied to a specific workspace path (`-w <dir>`) already registered with the Worker. Operate on the real working directory the user is already using for this project — a throwaway worktree copy would not match the registered workspace, and edits made there would not be the edits the user wanted reviewed.
- **This is meant to run long and unattended.** A single `wait` can block for up to 15 minutes, and the full loop can span many rounds. That is normal, not a stall — do not shorten timeouts, poll around `wait` in a loop, or treat a long-running turn as a sign to give up. Report back only when the task reaches a real stopping point (`DONE`, `BLOCKED`, or a `handoff`), not after every round.
- **Mid-task updates arrive as messages to this agent, not as a new spawn.** If the user has something to add while this is running, expect it as a continuation of this same session; fold it in the way SKILL.md's "Recovery and new instructions" section describes — keep the existing objective, incorporate the update, carry any resulting deviation in the next `report` — rather than starting over.
- **If you are at real risk of being cut off** (approaching your own session's limits, not just gpt-worker's), use `handoff` instead of leaving the task stuck mid-round — see SKILL.md's "Hand the task to another agent" section. A fresh agent, subagent or otherwise, can pick it up later without anything from this one.
- **Your final report is what the calling session sees.** Make it a genuine summary of the outcome (state, what changed, what was validated, what remains) — not a blow-by-blow of every round.
