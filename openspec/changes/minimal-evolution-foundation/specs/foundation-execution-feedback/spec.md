## ADDED Requirements

### Requirement: Preserve structured execution facts
The runtime SHALL retain available failure stage, stable reason, raw error code and usage completeness in existing event and session records without inferring task correctness.

#### Scenario: Model network failure
- **WHEN** a model request fails before returning usage
- **THEN** the live and restored records identify the model failure and leave missing usage unknown

#### Scenario: Legacy history
- **WHEN** a stored record lacks new failure details
- **THEN** it remains readable and absent details are not invented

#### Scenario: Completed execution with no quality evidence
- **WHEN** a tool or candidate completes without external quality validation
- **THEN** completion is recorded without declaring task success or improvement
