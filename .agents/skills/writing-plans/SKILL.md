---
name: writing-plans
description: Use when the user requests an implementation plan or a substantive multi-file change needs design decisions. Routine builds and small fixes need only a short inline plan.
---

# Writing Plans

Write the smallest plan that resolves implementation decisions. Work inline; delegate only when the user explicitly requests it.

1. Inspect the affected files and applicable contracts. Search for an existing plan before creating another; use task status to distinguish pending work from history.
2. Record the goal, approach, constraints, exact files to change and focused validation. Explain dependencies and genuine risks. Prefer a few coherent tasks over per-edit checklists.
3. Save requested or substantial plans to `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`. Otherwise keep the plan in chat. Keep status in `todo.md` and runtime rules in the canonical contracts.
4. Check coverage and paths once. Resolve material gaps, then implement if already requested; do not add an approval or skill-handoff ceremony.

Suggested structure:

```markdown
# [Feature] Implementation Plan

**Goal:** [Outcome]
**Approach:** [Design and boundaries]
**Constraints:** [Privacy, platform and compatibility requirements]

### Task 1: [Coherent deliverable]
**Files:** [Exact paths and responsibilities]
**Implementation:** [Decisions needed to execute]
**Validation:** [Exact focused commands and acceptance evidence]
```

Link authoritative details instead of copying whole contracts, source files or artifact inventories. Keep a section index for long plans so later work can load the global constraints and current task without rereading historical appendices. Expand into detailed test cases or machine-specific recipes only when requested or needed for high-risk behavior. Do not require a commit, reviewer, full suite or separate skill after every task.
