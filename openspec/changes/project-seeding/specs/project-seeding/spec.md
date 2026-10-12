## ADDED Requirements
### Requirement: Global strain library
The system SHALL retain named strains in Git and SQLite and allow publishing a saved project implementation version as a new strain without copying project runtime data.
#### Scenario: Publish saved version
- **WHEN** a user publishes a registered project version
- **THEN** the saved Git implementation is retained in the library and is selectable for seeding
### Requirement: Independent project seeding
The system SHALL initialize each project from a selected strain and retain its own implementation history, growth records and sessions.
#### Scenario: Choose a starting strain
- **WHEN** an uninitialized project is seeded from a known strain
- **THEN** an independent initial implementation and its strain provenance are persisted
#### Scenario: Existing project
- **WHEN** a user tries to seed an already initialized project
- **THEN** existing versions, selections and history remain unchanged and the operation is rejected
#### Scenario: Concurrent projects
- **WHEN** two projects start without explicit runtime roots
- **THEN** they use distinct runtime stores and supervisors
