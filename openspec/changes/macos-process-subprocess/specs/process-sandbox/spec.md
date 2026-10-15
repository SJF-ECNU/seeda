## ADDED Requirements
### Requirement: macOS subprocess evaluation
The macOS process backend SHALL execute subprocesses inside the same Seatbelt boundary without requiring Docker or changing the default backend.
#### Scenario: Ordinary coding evaluation
- **WHEN** a candidate invokes Bash, a compiler, tests or Git
- **THEN** available tools execute with inherited filesystem and network restrictions
### Requirement: Protected sandbox cleanup
The host SHALL reclaim candidate descendants on completion, cancellation, timeout and supervisor exit, including descendants that detach or reparent, and SHALL NOT signal unrelated host processes or other sandboxes.
#### Scenario: Candidate tries to kill cleanup
- **WHEN** a candidate sends a signal to the sandbox cleanup process
- **THEN** Seatbelt denies the signal and cleanup remains available
#### Scenario: Detached child survives its parent
- **WHEN** a child detaches and its parent exits
- **THEN** ending the evaluation terminates the child without relying on candidate-reported process identifiers
