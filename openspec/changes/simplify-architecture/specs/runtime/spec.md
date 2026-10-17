## ADDED Requirements
### Requirement: Focused runtime responsibilities
The runtime SHALL separate socket framing from operation dispatch without changing cancellation concurrency or event correlation.
#### Scenario: Cancel an active request
- **WHEN** a client sends cancel while a run is waiting
- **THEN** cancel is dispatched before the run completes and events retain the originating request id
### Requirement: Consistent agent composition
The core SHALL provide runtime record access without depending on the external tools module, and direct and worker entry points SHALL share model environment construction.
#### Scenario: Versioned worker startup
- **WHEN** an Agent-only snapshot starts a worker
- **THEN** its model configuration and runtime record tool remain available without host modules
