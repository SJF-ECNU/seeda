## ADDED Requirements
### Requirement: Token window budget
The default context window SHALL be 1000000 tokens with output capacity reserved and measured provider usage preferred over estimates.
#### Scenario: Existing usage
- **WHEN** the provider reports prompt token usage
- **THEN** it calibrates the next context estimate and the TUI shows tokens with the configured window
