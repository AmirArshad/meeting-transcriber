# Agent usage audit — 2026-11-15

## Findings

The main avoidable cost is workflow/context amplification around builds. The repository has a single 8,955-byte root guide at baseline, canonical skills with thin Claude links, scoped Cursor pointers, and ignored generated trees. Skill bodies/resources are loaded on demand; their presence on disk does not mean every session loads them.

Evidence was gathered from tracked source/instructions and a small, read-only sample of local Codex logs matching this repository. Only aggregates and repo-relevant findings are recorded here; raw transcripts, account identifiers, local configuration and user data are not included. This is not a billing audit or a controlled before/after usage benchmark.

| Finding | Evidence and interpretation |
|---|---|
| Personal plugin duplicates project workflows | November 10 and 15 sessions read the cached Superpowers 7.0.1 router. It requires invoking a skill even at 1% relevance and brainstorming before planning. A November 10 run also loaded its TDD skill. The repo had already removed these mandatory workflows, but its setup did not prevent the personal plugin loading. |
| Multi-agent work materially multiplies usage | The latest implementation explicitly authorized three workers. The lead and workers recorded 422 usage records and 1,800,730 characters of tool output in total. Delegation was requested, not an unexplained autonomous fan-out. Scope and repetition around that workload can still be improved. |
| Context grew very large | The lead's final recorded request had 303,502 input tokens, 303,104 cached. Lead cumulative input was 27,498,168 tokens, of which 27,160,320 were cached; its output was 57,419 tokens. The three worker counters were separate. Cumulative input repeatedly counts context and is not unique content or equivalent uncached billing. No subscription usage percentage can be inferred from these figures. |
| Skills encourage redundant work | Baseline verification says checks must run “in this message” and requires reading full output. Planning mandates a saved template and handoff even for ordinary multi-step work. Review metadata triggers at any task completion. Branch finishing reruns tests and forces a menu. Debugging mandates red/green for all fixes. These conflict with the root's proportional-work guidance. |
| Repeated builds/checks are visible, but not all are waste | The latest lead launched three Linux builds and four full-suite runs, including a pre-push run. Some followed integration fixes and were justified. The improvement is to reuse evidence for unchanged inputs, not to skip qualification or assert every repeated run was unnecessary. |
| Large on-demand files make broad reads expensive | The v2.11 plan is 85,798 bytes; it was explicitly requested to be detailed. Parakeet lockfiles are 684,970–1,319,809 bytes. `src/renderer/app.js` is 275,929 bytes and transcription service is 164,702 bytes. Reads of these files can dominate a small root-guide saving. Preserve their content and use section/key/symbol queries. |
| Runtime facts in instructions had drifted | Root instructions said Electron 44 and macOS 14, while the branch pins Electron 46 alpha and the packaging contract records macOS 15. Point to authoritative manifests/contracts to avoid repeated conflict resolution. |

## Implemented improvements

1. **Project-local plugin override.** Disable `superpowers@openai-curated-remote` in the ignored checkout configuration, preserving its existing setting. A tracked `.codex/config.example.toml` and `.agents/README.md` explain how to apply the same override on other machines. Global configuration and plugin cache are untouched. This follows [Codex's project-plugin configuration](https://developers.openai.com/plugins/build/plugins#enable-or-disable-a-plugin-for-a-repo).
2. **Six concise workflow skills.** Narrow triggers, remove automatic workflow chaining, use proportional debugging and review, and make branch-decision guidance explicit-only across supported metadata. Keep all 16 skills, their resources and licenses; preserve provenance hashes and mark edited upstream adaptations.
3. **Evidence reuse.** Passing results remain valid for unchanged code, dependencies and relevant environment. One lead owns integrated gates; workers use scoped tests. A commit/push request does not automatically require another full suite.
4. **Bounded build work.** Search before large reads, query lockfile keys, read plans by constraints/current phase, capture verbose logs, retain real exit status and wait for completion instead of repeated short polls. Existing package/resource validation remains intact.
5. **Maintenance guards.** Validate explicit-only policies as actual YAML booleans, and enforce an 8 KiB guide, 3 KiB per core workflow and 12 KiB combined workflow budget. Fixture tests cover boundaries, UTF-8 size, missing workflows and false-looking/malformed policies. Skill-authoring instructions now use the repository validator instead of the generic bundled helper, which rejects the repo's supported manual-invocation field.

## Measured instruction footprint

UTF-8 file bytes, including skill frontmatter. These are file-size reductions, not a promised billing reduction.

| Surface | Before | After |
|---|---:|---:|
| Root `AGENTS.md` | 8,955 | 8,056 |
| Six core workflow `SKILL.md` files combined | 30,417 | 11,798 |

The six workflow bodies/metadata are **61.2% smaller**. Root instructions are **10.0% smaller**, while adding concrete usage guidance. The larger potential benefit is avoiding unnecessary skill loading, repeated output and re-verification in long sessions.

## Verification and limits

- Setup validator: all 16 canonical skills, relative links, index, YAML, command references, adapters and budgets pass.
- Setup/link regression suite: 17 tests pass on Linux.
- Project plugin override is structurally validated as TOML, including preservation of the existing local setting. The CLI plugin-list command timed out after 30 seconds; effective plugin discovery must be confirmed in a fresh trusted Codex session using `/plugins` and `/skills`.
- Windows/macOS setup execution and post-change Codex usage are not measured here. No installer or hardware acceptance is claimed for this instruction-only change.

See the [implementation plan](../superpowers/plans/2026-11-15-agent-usage.md) and [setup guide](../../.agents/README.md) for exact checks and log recipes. The prior [setup audit](AGENT_SETUP_AUDIT.md) remains historical evidence, not the current instruction inventory.
