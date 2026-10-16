## ADDED Requirements

### Requirement: Return bounded evaluation evidence
Candidate evaluation SHALL return available execution facts and a detailed evidence reference while retaining explicit evidence retrieval and existing sandbox protections.

#### Scenario: Candidate completion
- **WHEN** candidate execution ends
- **THEN** the caller receives bounded status, environment and failure or usage facts without claiming comparative quality

### Requirement: Combine explicit acceptance and promotion safely
Promotion MAY receive an explicit acceptance reason and SHALL reuse existing source, candidate, completion and switch checks before recording acceptance and requesting promotion.

#### Scenario: Stale evaluation
- **WHEN** the evaluation belongs to a stale source or a different candidate
- **THEN** combined acceptance and promotion is rejected without switching versions

#### Scenario: Existing management caller
- **WHEN** a caller uses separate decide and promote operations
- **THEN** existing supported behavior remains available

#### Scenario: Memory update
- **WHEN** a versioned memory change is adopted
- **THEN** it retains candidate validation, explicit acceptance, actual version loading and rollback without overwriting project rules
