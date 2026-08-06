# Domain Docs

Before exploring the codebase, read:

- `CONTEXT.md` at the repo root, if present.
- Relevant ADRs under `docs/adr/`, if present.

Proceed silently when these files do not exist. Domain-modeling skills create them only when useful.

## Layout

This is a single-context repository:

/
├── CONTEXT.md
├── docs/adr/
└── src/

Use vocabulary defined in `CONTEXT.md`. Surface conflicts with existing ADRs rather than silently overriding them.
