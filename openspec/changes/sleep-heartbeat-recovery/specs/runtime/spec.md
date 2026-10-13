## ADDED Requirements
### Requirement: Heartbeat observation after supervisor suspension
The supervisor SHALL give workers a fresh heartbeat observation window after its own monitoring pauses, while still terminating genuinely unresponsive workers.
#### Scenario: First monitor tick after sleep
- **WHEN** the supervisor resumes after a monitoring gap longer than its heartbeat timeout
- **THEN** it waits a fresh observation window rather than immediately killing a worker
#### Scenario: Genuine heartbeat loss
- **WHEN** monitoring runs normally and a worker remains unresponsive
- **THEN** it terminates the worker and records a heartbeat timeout reason
