## ADDED Requirements
### Requirement: Same-version recovery before fallback
The supervisor SHALL retry the failed implementation twice before attempting the previous implementation once, without resetting attempts on readiness alone.
#### Scenario: Repeated crash
- **WHEN** a worker starts successfully but crashes again before completing its task
- **THEN** recovery remains bounded and only falls back after the same-version attempts
### Requirement: Auditable continuation
The runtime SHALL preserve the original task, cancellation, external budgets, failure facts and uncertain tool outcomes during recovery.
#### Scenario: Repair after restart
- **WHEN** the failed version restarts with resume support
- **THEN** the Agent can inspect runtime records and use existing draft/evaluate/accept operations without duplicating the user task or replaying tools
#### Scenario: Fixed implementation evaluation
- **WHEN** recovery would require fallback in a fixed-version evaluation
- **THEN** the trial stops without replacing the evaluated implementation
