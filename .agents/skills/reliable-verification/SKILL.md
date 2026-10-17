---
name: reliable-verification
description: Preserve explicit input and candidate files, then check a real process exit and artifacts in a fresh working directory. Use for repeated experiments, destructive transformations, or suspicious validation results.
---

Use the existing Bash tool and `scripts/verify.py` (Python 3 standard library). This is local self-verification, not an official benchmark score or a security sandbox. Public requirements determine checks; never inspect hidden tests.

First check `command -v python3`. If unavailable, do not install a runtime merely to use this skill. Follow the same procedure with existing shell tools: create a new record directory, `cp` selected untouched inputs once, create a new numbered work directory for each attempt, and copy inputs and candidate files there. Invoke the target directly, immediately save `$?`, then run each check and save its own exit code. The final shell exit must reflect **all** these codes, not the last `echo`/`head` command. Keep output, logs and candidate copies. For example, `target >command.log 2>&1; target_rc=$?; cmp output expected >check.log 2>&1; check_rc=$?; printf 'target=%s check=%s\n' "$target_rc" "$check_rc"; test "$target_rc" -eq 0 && test "$check_rc" -eq 0`. Use the existing Bash timeout safeguard for hangs. This fallback has the same evidence requirements; the Python helper only automates them.

1. Before modifying input, choose the required input files and capture them once:
   `python3 scripts/verify.py init RECORD_DIR SOURCE_DIR input.txt expected.txt`
   Paths are relative to SOURCE_DIR. A pre-existing RECORD_DIR is rejected. Capture cannot prove that your source was originally clean: obtain a fresh legitimate source if provenance is uncertain.
2. Write a JSON specification and run `python3 scripts/verify.py run RECORD_DIR spec.json`:
   ```json
   {"hypothesis":"The command should finish successfully and produce the expected bytes", "candidate_source":"/path/to/current/code", "candidates":["program.py"], "command":["python3","program.py"], "checks":[["cmp","output.txt","expected.txt"]], "artifacts":["output.txt"], "timeout_seconds":30}
   ```
   Each run copies saved inputs and current candidate files to a new attempt directory and invokes argv directly. Use relative input/output paths, not the original working files. Do not wrap the target in `sh -c 'target; echo done'`: the actual target must be the command. A caller-specified per-command timeout is a tool execution safeguard, not an experiment budget.
3. Read `result.json`, process logs, and actual artifacts. `passed` requires target exit 0, every declared check exit 0, and every declared artifact present. Checks must cover the **public requirements**, including syntax, allowed operations and termination where applicable. Passing your checks does not imply complete coverage or official success.
4. Keep the attempt directory. After a regression, recover candidate files from the earlier passing attempt's `candidate/`; never call a new failing version "the verified version". The helper never overwrites an earlier attempt. Input copies are for reproducibility, not protection against a malicious program; existing sandbox restrictions still apply.

Before each experiment state the hypothesis, changed variable, and what result would distinguish it. Use the result to choose the next action. If two attempts produce the same evidence, inspect existing logs (including `runtime_records`) before another variation. Change the hypothesis or obtain a smaller counterexample; do not keep renaming the same attempt.

If **no candidate has passed all known requirements**, preserve the best partial result and explicitly list failing/unverified requirements. There is no successful version to revert to. Either run an experiment that can resolve a specific unknown or submit the incomplete result honestly. Do not claim success from matching bytes alone when the command failed.

When changing this strategy, specify a behavior prediction and exercise it in native evaluation: e.g. nonzero target exit despite matching output, a failed regression after a passing candidate, and no passing candidate. Inspect the recorded actions and files, not just the evaluation's completed status. These are examples to adapt, not benchmark answers.
