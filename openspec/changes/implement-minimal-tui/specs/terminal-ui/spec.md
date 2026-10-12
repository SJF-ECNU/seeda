## ADDED Requirements

### Requirement: Separate display and interaction
The TUI SHALL submit text and cancellation through existing core methods and display AgentEvent without owning model calls, tool execution or session writes.

#### Scenario: Stream and tool events
- **WHEN** the core emits text deltas and tool start/end events
- **THEN** the TUI displays growing assistant text and updates the matching tool status.

### Requirement: User control and recovery
The TUI SHALL keep an editable input area, allow cancellation and return to usable input after failure or cancellation.

#### Scenario: Cancel a running request
- **WHEN** the user presses Ctrl+C while busy
- **THEN** the TUI calls cancel, displays the core cancellation outcome and allows a new request.

#### Scenario: Avoid duplicate requests
- **WHEN** the user presses Enter while busy
- **THEN** no additional core request starts and the draft remains available.

### Requirement: Safe terminal lifecycle
The TUI SHALL restore raw mode and terminal screen on exit, handle resizing, and display untrusted text without interpreting embedded terminal controls.

#### Scenario: Resize and exit
- **WHEN** the terminal resizes and the user exits while idle
- **THEN** the layout fits the new dimensions and original terminal mode is restored.

### Requirement: Session presentation and non-TTY compatibility
The TUI SHALL display existing user, assistant and tool messages, while non-TTY and one-shot commands SHALL preserve plain output.

#### Scenario: Resume a session
- **WHEN** the TUI opens with existing core-owned messages
- **THEN** prior conversation is visible without re-running tools or rewriting session records.
