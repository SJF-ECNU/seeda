## ADDED Requirements
### Requirement: Stable presentation
The installed CLI and TUI SHALL be independent of project Agent version selection.
#### Scenario: Broken version CLI
- **WHEN** a saved Agent version contains a broken frontend entry
- **THEN** the installed CLI still handles management and presentation
### Requirement: Agent-only snapshots
New implementation versions SHALL exclude presentation and external lifecycle management code.
#### Scenario: Legacy candidate
- **WHEN** a candidate descends from a legacy full-source version
- **THEN** submission retains Agent changes and removes frontend and management files from the new snapshot
