# Option 1: Merge Locally

Reached from Step 5 of `SKILL.md` in this directory, after the user picked option 1.

**Precondition:** tests passed in Step 1, and the harness has not pinned you to a designated branch. If it has, stop and offer Option 2 (push and open a PR) instead — merging to the base branch would violate that constraint.

## Merge

```bash
# Get main repo root for CWD safety
MAIN_ROOT=$(git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel)
cd "$MAIN_ROOT"

# Merge first — verify success before removing anything
git checkout <base-branch>
git pull
git merge <feature-branch>
```

## Verify

Run the test command on the merged result. Do not continue if it fails — a merge can break what both sides passed independently.

```bash
<test command>
```

## Clean up, then delete the branch

Only after the merge succeeds and tests pass on the result:

1. Run **Step 6: Cleanup Workspace** in `SKILL.md` (already in your context — do not re-read the file).
2. Then delete the branch:

```bash
git branch -d <feature-branch>
```

`-d` not `-D`: it refuses if the branch is unmerged, which is the safety check you want here. Removing the worktree before this step is required, or the delete fails because the worktree still references the branch.
