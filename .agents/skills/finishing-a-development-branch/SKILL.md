---
name: finishing-a-development-branch
description: Use only when explicitly requested to help decide how to merge, open a PR or clean up tested work. An already specified commit and push needs no decision workflow.
disable-model-invocation: true
---

# Finishing a Development Branch

Help resolve an integration choice. Follow an already chosen action directly within its authorization; do not ask the user to choose it again.

## Step 1: Verify evidence

Check the current diff and applicable test evidence. Reuse successful checks for unchanged inputs. Run missing gates; diagnose failures before merging or claiming readiness. Every PR still requires `npm run test:all`.

## Step 2: Detect environment

Inspect branch, upstream, working tree and worktree ownership. Preserve unrelated changes. A designated development branch stays the target unless the user authorizes a different one.

## Step 3: Determine base

Use the actual upstream/history or ask if ambiguous. Do not assume `main` or `master`. A detached or harness-owned workspace needs an explicit destination before publishing.

## Step 4: Resolve the choice

If undecided, offer only applicable choices: (1) merge locally, (2) push/open PR, (3) keep as-is, (4) discard. Ask once. A commit/push request does not also authorize a PR, merge, release or deletion.

## Step 5: Execute the authorized choice

- **Merge:** Read `merge-locally.md`; verify the merged result before any cleanup.
- **Push/PR:** Inspect and stage only intended files, commit/push only with authorization, and open a PR only if requested. Preserve the worktree; report the actual remote result. Never force-push without an explicit request.
- **Keep:** Report the branch and remaining work.
- **Discard:** Read `discard.md`; enumerate the exact loss and require explicit confirmation before deletion.

## Step 6: Cleanup Workspace

Only consider cleanup after an authorized merge or discard. Confirm the worktree was created by this task and its removal is authorized; a `.worktrees/` directory name alone is not proof of ownership. Preserve harness-owned and unfamiliar worktrees. Never remove the primary checkout.

Move outside the target before `git worktree remove <path>`. Do not force removal. Prune stale registration only when needed. Delete a merged branch with `git branch -d` only after its worktree is removed; force deletion is reserved for the specifically confirmed discard. Skip cleanup if ownership or authorization is unclear.
