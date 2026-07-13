---
name: executing-plans
description: Use when you have a written implementation plan to execute inline with focused verification
---

# Executing Plans

## Overview

Load plan, review critically, execute all tasks, report when complete.

**Announce at start:** "I'm using the executing-plans skill to implement this plan."

Use inline execution by default. Consider a subagent only for an explicitly requested independent review or a high-risk cross-process, concurrency, persistence, packaging, or security boundary.

## The Process

### Step 1: Load and Review Plan
1. Read plan file
2. Review only for material gaps that would block safe implementation
3. If concerns: Raise them with your human partner before starting
4. If no concerns: Create todos for the plan items and proceed

### Step 2: Execute Tasks

For each task:
1. Mark as in_progress
2. Follow the plan's intent; combine routine steps when it improves flow without skipping requirements
3. Run focused verifications as specified
4. Mark as completed

### Step 3: Complete Development

After all tasks complete and verified:
Use `finishing-a-development-branch` only when the user asks for merge/PR/cleanup guidance.

## When to Stop and Ask for Help

**STOP executing immediately when:**
- Hit a blocker (missing dependency, test fails, instruction unclear)
- Plan has critical gaps preventing starting
- You don't understand an instruction
- Verification fails repeatedly

**Ask for clarification rather than guessing.**

## When to Revisit Earlier Steps

**Return to Review (Step 1) when:**
- Partner updates the plan based on your feedback
- Fundamental approach needs rethinking

**Don't force through blockers** - stop and ask.

## Remember
- Review the plan for material gaps first
- Follow the plan's requirements
- Don't skip verifications
- Use skills only when their workflow adds clear value
- Stop when blocked, don't guess
- Never start implementation on main/master branch without explicit user consent

## Integration

Use related workflow skills only when their specific workflow is needed.
