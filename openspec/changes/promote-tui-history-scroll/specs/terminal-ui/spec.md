## ADDED Requirements

### Requirement: History scrolling and position
The TUI SHALL support keyboard history scrolling, show a scrollbar for overflowing history, and preserve the viewport while new content streams.

#### Scenario: Reading streaming history
- **WHEN** the user scrolls up and new lines arrive
- **THEN** the same historical lines remain visible and the footer shows history position

#### Scenario: Terminal alternate scrolling
- **WHEN** a compatible terminal translates wheel input to arrows
- **THEN** the history scrolls without mouse capture
