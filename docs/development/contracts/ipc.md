# IPC contract

IPC ownership is defined in `AGENTS.md`'s contract index. A channel rename or payload change updates its owning `src/main` service, `src/preload.js`, every renderer call site, and characterization/source-scan tests. Keep `src/main.js` a composition root and preserve the export key sets of `main-process-helpers` and `ai-addon-setup`.
