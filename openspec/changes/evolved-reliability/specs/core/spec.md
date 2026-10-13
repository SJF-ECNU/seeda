## ADDED Requirements
### Requirement: Transient request retries
The model adapter SHALL retry transient failures within a finite attempt budget, but SHALL NOT replay after streamed output or caller cancellation.
#### Scenario: Per-attempt timeout
- **WHEN** one attempt times out while the caller remains active
- **THEN** a later attempt may succeed
### Requirement: Tool cleanup failure containment
A Bash cleanup error SHALL be reported as a tool result without terminating the Agent process.
#### Scenario: Process group permission error
- **WHEN** group cleanup returns EPERM
- **THEN** the tool does not throw from an asynchronous event handler
