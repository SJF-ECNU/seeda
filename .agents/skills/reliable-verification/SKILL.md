---
name: reliable-verification
description: Validate real process exits and outputs on preserved inputs, retaining every candidate and result.
always: true
---

For repeated tests or transformations that edit inputs, use `verify` to capture selected untouched inputs before the first run, then run each candidate in a fresh attempt directory. The tool saves candidate files, inputs, output logs and per-check exits; it works through the current Bash execution environment without Python. Its result is local evidence, not an official benchmark score.

Before testing, state the hypothesis and checks derived from the public requirements. Pass the target as an argv array, with separate check argv arrays and required artifacts. Do not hide the target in `sh -c 'target; echo done'`: matching output cannot cancel a nonzero target exit. Include syntax, allowed operations and termination requirements when the task specifies them; do not invent stricter requirements.

Read the returned result. A passing attempt is a recoverable candidate: keep its path and validate remaining requirements before trying unrelated alternatives. On a regression, recover that attempt's candidate files; do not overwrite the passing copy. If none passed all requirements, state what remains failed or unverified and preserve the best partial result. Never call a partial result a completed solution.

When attempts repeat the same evidence, inspect existing logs via `runtime_records` and recorded artifacts, identify the unanswered question, and choose a discriminating small test or honestly submit the incomplete result. A new filename or command permutation alone is not progress. Completion takes priority over unrequested perfection.

These instructions and the verification tool implementation are versioned, evolvable code. Improve them through draft, actual behavioral evaluation and explicit acceptance. Do not alter existing evidence or the external evaluator. If an older runtime has no `verify` tool, scripts/verify.py provides the same saved-attempt workflow where Python is available; otherwise use Bash to copy inputs and candidates into separate directories and record target/check exit codes individually.
