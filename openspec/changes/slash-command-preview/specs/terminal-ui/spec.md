## ADDED Requirements
### Requirement: Slash command preview
The TUI SHALL preview supported slash commands with descriptions and prefix filtering above the input.
#### Scenario: Navigate and complete
- **WHEN** an idle user types / and uses arrow keys and Tab
- **THEN** the matching selection is visible and its command is completed without executing a request
#### Scenario: Parameter command
- **WHEN** Enter selects /resume or /use
- **THEN** the input is completed with a trailing space and waits for the required argument
#### Scenario: Limited terminal space
- **WHEN** a command preview is open in a narrow or short terminal
- **THEN** the input remains in its fixed position and preview lines remain within the display width
