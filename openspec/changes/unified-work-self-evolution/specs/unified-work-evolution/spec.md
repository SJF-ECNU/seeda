## ADDED Requirements
### Requirement: Same-task version continuation
The runtime SHALL let an accepted pending version take over after a complete tool batch and continue the same user task, session and workspace without replaying tools or adding another user instruction.
#### Scenario: Accepted executable change
- **WHEN** the current Agent promotes a validated candidate during a tool batch
- **THEN** all batch results are persisted, the previous writer stops, the selected implementation starts and the same task continues with its code
### Requirement: Existing safety and cancellation
The runtime SHALL preserve isolated evaluation, explicit acceptance, recovery order, usage records and cancellation when handing over.
#### Scenario: Cancellation during handover
- **WHEN** the user cancels before or during the pending handover
- **THEN** no further task continuation occurs and pending switches are resolved without replaying effects
#### Scenario: Startup failure
- **WHEN** the candidate fails to start
- **THEN** existing retries and fallback apply, and the continuing Agent receives factual evidence rather than a new learning assignment
### Requirement: No forced learning phases
The normal Agent loop SHALL expose existing work and evolution tools together without requiring benchmark scores or reflection stages.
#### Scenario: Work without self-change
- **WHEN** an Agent completes a task without requesting evolution
- **THEN** normal execution completes with no added reflection model calls or mandatory candidate
