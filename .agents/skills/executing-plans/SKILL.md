---
name: executing-plans
description: Use when implementing an existing written plan supplied by the user or resumed from an earlier session. Do not reload a plan just written in the current context.
---

# Executing Plans

Work inline on the current branch. Delegate only when explicitly requested; high-risk work alone is not authorization.

1. Check the working tree and current task status. Read the plan goal, global constraints, sequencing and applicable task sections. Use a heading search for long plans; load referenced details before editing the surface they govern. Reuse content already in context.
2. Resolve material gaps. Continue independent work when a native host, dependency or user decision blocks one phase. Diagnose failures before asking the user to solve them.
3. Implement coherent tasks and run their focused checks. Keep brief status/evidence in `todo.md`; do not manufacture per-step commits, reviews or handoffs.
4. Integrate changes, inspect the diff and run the required final gate once for the integrated inputs. Reuse passing evidence while code, dependencies and relevant environment remain unchanged. Report remaining platform gates honestly.

For authorized parallel work, assign exact disjoint files, small task-specific context and focused tests. The lead owns shared integration, the full suite and installers. Workers report changed files, outcomes and blockers once; use completion notifications instead of status polling. Do not copy the entire parent transcript or repeatedly broadcast unchanged status when the harness supports scoped context.

When finished, carry out the requested delivery. A request to commit/push already settles that choice; it does not authorize a PR, merge or cleanup. Use branch-decision guidance only if the user requests an unresolved integration decision.
