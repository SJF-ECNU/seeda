## ADDED Requirements
### Requirement: Agent-owned Git grafting
The Agent SHALL be able to graft selected saved strain changes using existing Bash/Git and management interfaces without a dedicated graft tool.
#### Scenario: Generate and apply a patch
- **WHEN** the Agent chooses source/base commits and implementation file scope
- **THEN** Bash Git commands can export and apply that scope in a target draft while the primary remains unchanged
#### Scenario: Conflict
- **WHEN** Git application checking fails
- **THEN** the Agent can retain and resolve the editable draft without overwriting the primary
### Requirement: Existing candidate verification and promotion
The Agent SHALL reuse submit, evaluate, evidence, decide and promote to verify and select a graft candidate, recording source provenance in the version reason.
#### Scenario: Verified graft
- **WHEN** the Agent accepts completed candidate evidence and requests promotion
- **THEN** the runtime selects the candidate at the existing request boundary and retains the preceding target version for rollback
