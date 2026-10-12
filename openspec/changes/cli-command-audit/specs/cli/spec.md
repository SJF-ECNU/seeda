## ADDED Requirements
### Requirement: Explicit CLI command routing
The CLI SHALL route known controls locally and require run or -- for model task text.
#### Scenario: Unknown command
- **WHEN** a misspelled command is entered
- **THEN** it exits with a usage error without starting a model request
### Requirement: Strict control parameters
The CLI SHALL reject missing, extra, empty or unknown control parameters before opening runtime resources.
#### Scenario: Invalid publication arguments
- **WHEN** publish has missing or duplicate introduction options or excess positional arguments
- **THEN** it fails locally without registering a strain or executing a model task
