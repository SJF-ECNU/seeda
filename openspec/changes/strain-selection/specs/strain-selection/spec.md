## ADDED Requirements
### Requirement: User-selected default strain
The library SHALL persist a user-selected default strain for future seeding without changing existing project versions.
#### Scenario: New project uses default
- **WHEN** a noninteractive new project initializes without a strain name
- **THEN** it uses the persisted default strain
### Requirement: Searchable seed selection
The interactive seed command SHALL provide searchable keyboard selection and selected strain introductions.
#### Scenario: Cancel selection
- **WHEN** the user cancels the selector
- **THEN** no project is seeded and terminal settings are restored
### Requirement: Standardized introduction
Publication SHALL require summary, improvements, scenarios, limitations and validation text, while retaining legacy entries with missing introductions.
#### Scenario: Missing fields
- **WHEN** a publication omits a required introduction field
- **THEN** it is rejected before registering a strain
