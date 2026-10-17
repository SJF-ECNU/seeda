## ADDED Requirements
### Requirement: Single ownership for lifecycle state
The supervisor SHALL derive active request and recovery state from their owning callback and promise, while preserving cancellation and process isolation.
#### Scenario: Recovery under cancellation
- **WHEN** cancellation arrives while a replacement worker is starting
- **THEN** the original request remains cancelled and no new model allowance is created
### Requirement: Shared primary startup
The supervisor SHALL use one primary-worker startup path without changing candidate sandbox execution or recovery ordering.
#### Scenario: Repeated crash
- **WHEN** the same implementation fails repeatedly before task completion
- **THEN** the existing same-version retries and bounded fallback policy remain unchanged
