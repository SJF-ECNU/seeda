## ADDED Requirements
### Requirement: Local help handling
The CLI SHALL handle help and version flags before starting an Agent or connecting to runtime services.
#### Scenario: Help with existing runtime
- **WHEN** the user runs seeda -h or --help
- **THEN** usage is printed locally without connecting to the supervisor or modifying sessions
### Requirement: Distinguish options from prompts
The CLI SHALL reject unknown leading options and allow an explicit -- separator for literal prompts.
#### Scenario: Unknown option
- **WHEN** an unknown leading option is supplied
- **THEN** the CLI exits with an error without submitting a model request
