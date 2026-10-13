# Lane demo-lane — review

You are an independent reviewer from a different model family. Read the implementer's diff
(`git log -p` on the lane branch in your cwd) and the brief next to this file. Do not edit code.

Check: the `--version` flag works, tests were written first and pin the behaviour, nothing
outside the brief's paths changed.

VERDICT FILE: verdict.md

Write the verdict file. Its FIRST line must be exactly one of:

    VERDICT: ACCEPT
    VERDICT: ACCEPT WITH FIXES
    VERDICT: REJECT

Findings (file:line, why, how to fix) follow below the first line.
