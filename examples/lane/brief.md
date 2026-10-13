# Lane demo-lane — add a `--version` flag

You are the implementer. Work only in your cwd and edit only the files this brief names.

## Task

Add a `--version` flag to the CLI that prints the version from `package.json` and exits 0.
Write the failing test first, then implement. Commit on your lane branch; never push to `main`.

## Hand-back

If you need a decision from the parent, write `01-question.md` in the lane directory
(its path is in the message that carried this brief), print `PI-ORCH-LANE-QUESTION` on its
own line and stop. Otherwise end with your completion report.

GATES:
- `env NODE_ENV=test npm test` → 0
- `npm run typecheck` → 0
