## ADDED Requirements
### Requirement: Incremental terminal redraw
The TUI SHALL position each changed row explicitly and SHALL NOT clear the whole screen or emit line feeds during ordinary streaming updates.
#### Scenario: Streaming a long Chinese response
- **WHEN** response deltas arrive with unchanged header and footer
- **THEN** only changed rows are rewritten without scrolling the terminal
#### Scenario: Terminal resize
- **WHEN** terminal dimensions change
- **THEN** the visible viewport is rebuilt within the new dimensions
