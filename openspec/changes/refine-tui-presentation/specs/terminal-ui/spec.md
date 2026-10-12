## ADDED Requirements
### Requirement: Readable Markdown conversation
The TUI SHALL render common Markdown as structured terminal text with safely generated styles and display-width-aware wrapping.
#### Scenario: Streamed Markdown
- **WHEN** headings, lists, quotes, tables or an incomplete fenced code block arrive
- **THEN** the content stays readable within the viewport without leaking Markdown fences or terminal control instructions
### Requirement: Compact tool presentation
The TUI SHALL show a compact tool summary by default and allow full parameters and recorded output to be expanded without changing the session.
#### Scenario: Toggle tool details
- **WHEN** Ctrl+O is pressed
- **THEN** tool details are toggled while input draft and actual execution state remain unchanged
