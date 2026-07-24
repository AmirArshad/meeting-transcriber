# Option 4: Discard

Reached from Step 5 of `SKILL.md` in this directory, after the user picked option 4.

**This is irreversible.** Commits on a deleted branch with no worktree and no remote are effectively unrecoverable once the reflog expires.

## Confirm first

Show exactly what will be lost, then wait for the literal word:

```
This will permanently delete:
- Branch <name>
- All commits: <commit-list>
- Worktree at <path>

Type 'discard' to confirm.
```

Wait for exact confirmation. Anything other than `discard` — including "yes", "ok", or silence — is not confirmation. Do not proceed.

## Execute

```bash
MAIN_ROOT=$(git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel)
cd "$MAIN_ROOT"
```

Then:

1. Run **Step 6: Cleanup Workspace** in `SKILL.md` (already in your context — do not re-read the file).
2. Then force-delete the branch:

```bash
git branch -D <feature-branch>
```

`-D` is required because the branch is unmerged by definition — which is also why the typed confirmation above is not optional.
