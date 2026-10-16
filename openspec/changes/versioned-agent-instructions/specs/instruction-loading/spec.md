## ADDED Requirements

### Requirement: Load self context from the executing implementation
The Agent SHALL load self instructions and general memory from `.agents/self/INSTRUCTIONS.md` and `.agents/self/MEMORY.md` beneath the executing implementation root on each request and compaction.

#### Scenario: Promotion and rollback
- **WHEN** a candidate with modified self files is promoted or rolled back
- **THEN** the next actual model request uses the selected version's self context without copying files into the project

### Requirement: Preserve project-scoped rules
Project AGENTS.md and Skills SHALL continue to load from the task working directory, independently of self context.

#### Scenario: Candidate isolation
- **WHEN** a candidate runs in its independent sandbox workspace
- **THEN** it loads its own self context without inheriting the primary project rules

### Requirement: Report actual instruction sources without bodies
Each request and compaction SHALL persist source kind, path, read status and character length, exposed through current-session runtime records without file contents.

#### Scenario: Missing legacy files
- **WHEN** a legacy implementation lacks self files
- **THEN** project rules still load, self sources report not loaded, and implementation AGENTS.md is not substituted

#### Scenario: Restore history
- **WHEN** a session is reopened after compaction
- **THEN** recorded instruction provenance remains available independently of conversation context
