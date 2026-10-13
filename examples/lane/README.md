# Sample lane directory

A lane directory for `pi-orch lane run`. Copy it, edit `lane.json` (absolute `cwd`, your
`parentSessionId`, the routes) and `brief.md`, then:

```bash
pi-orch lane run ./examples/lane --dry-run      # validate + print the plan, no API call
pi-orch lane run ./my-lane &                    # run it as a background process; the exit code is the wake
```

See the README section "Lane runner" for the files the runner writes and the exit codes.
