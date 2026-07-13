# Fast Agent Defaults

Favor direct, bounded execution over process-heavy agent workflows.

- Do not launch a subagent for routine inspection, simple edits, focused testing, or plan self-review.
- Ask before launching any subagent. Use one only when the task is high-risk, crosses multiple processes/platforms, needs independent review, or the user explicitly requests it.
- Do not re-review the same work after feedback unless a material design or implementation change introduced a new risk.
- For plans, write the shortest file-level plan that makes the next implementation decision clear. Do not require per-step TDD scripts, commits, or subagent handoffs unless the user asks.
- For implementation, run the smallest relevant verification first. Run the full suite only for cross-cutting, packaging, recorder, persistence, or explicitly requested validation.
- Preserve safety-critical project invariants and use targeted tests for recorder, persistence, packaging, security, or cross-process changes.
