# SafeScript

## Architecture Overview

SafeScript is an embeddable restricted TypeScript compiler and runtime for platforms that let users or agents add application logic. The host defines the available types, functions, capabilities, authorisation, and resource limits; extensions receive no ambient file, network, process, package, environment, or credential access.

Source is parsed and checked, lowered to typed SafeScript IR, and run by a bounded interpreter. Host effects cross a typed action-request boundary where the host reauthorises each operation. TypeScript source is canonical; IR, semantic graphs, visual projections, and a later Wasm backend are derived and optional.

Read the [full project design](docs/SafeScript.md) only when a task needs deeper language, runtime, integration, roadmap, or security context.

## Conventions & Patterns

- SafeScript 0.7.0 is the TypeScript host SDK, transport-neutral runtime bridge, compiler, bounded IR interpreter, deterministic test API, and conformance suite.
- Keep contracts, diagnostics, IDs, limits, action requests, and outcomes stable and serialisable for later process-based SDKs.
- Compile-time effect and capability summaries never replace current runtime authorisation.
- SafeScript is not a workflow engine, no-code platform, approval system, durable runtime, or retry coordinator.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:7510c1e2 -->

## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**

- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

<!-- END BEADS INTEGRATION -->

## Build & Test

```bash
bun run build
bun run test
bun run lint
bun run typecheck
```

## Agent skills

### Issue tracker

Issues are tracked in the repo-local Beads database. See `docs/agents/issue-tracker.md`.

### Triage labels

The default five-role triage vocabulary is used. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses the single-context layout. See `docs/agents/domain.md`.
