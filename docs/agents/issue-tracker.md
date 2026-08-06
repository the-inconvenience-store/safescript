# Issue tracker: Beads

Issues and specs for this repo live in its repo-local Beads database. Use the `bd` CLI for all operations.

## Conventions

- **Create an issue**: `bd create --title "<title>" --description "<description>"`; add `--type`, `--labels`, or `--parent` as needed.
- **Read an issue**: `bd show <id> --json`, then `bd comments <id> --json` for its conversation history.
- **List issues**: `bd list --status open --json` with appropriate filters.
- **Comment on an issue**: `bd comment <id> "..."`
- **Apply/remove labels**: `bd label add <id> "..."` / `bd label remove <id> "..."`
- **Claim**: `bd update <id> --claim`
- **Close**: `bd close <id> --reason "..."`

Run commands from the repo so `bd` discovers the correct database. Treat Beads IDs as opaque strings.

## Skill operations

- **Publish to the issue tracker**: create a Beads issue with `bd create`.
- **Fetch the relevant ticket**: run `bd show <id> --json` and `bd comments <id> --json`.
