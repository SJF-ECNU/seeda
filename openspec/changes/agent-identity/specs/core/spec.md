## ADDED Requirements
### Requirement: Initial seeda identity
The core system prompt SHALL introduce seeda as a project-local coding agent whose self changes require candidate verification.
#### Scenario: Project without instruction file
- **WHEN** a session starts in a project without AGENTS.md
- **THEN** the fixed system prompt still supplies the seeda identity and verification expectations
