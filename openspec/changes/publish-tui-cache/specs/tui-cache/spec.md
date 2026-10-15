## ADDED Requirements
### Requirement: Shared stable TUI publication
All local project launches SHALL use the stable installation containing the committed TUI cache optimization.

#### Scenario: Global command resolves the updated renderer
- **WHEN** seeda is launched from an existing project through the global command
- **THEN** the command uses this repository's stable CLI and TUI without replacing Agent versions or sessions
