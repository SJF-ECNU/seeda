## ADDED Requirements

### Requirement: Independent agent loop
The system SHALL run the model and tools without depending on a TUI, emit execution events, and end normally only after a complete stop response without tool calls.

#### Scenario: Tool followed by answer
- **WHEN** a model returns complete Bash calls
- **THEN** the core executes them sequentially, persists corresponding results and calls the model again.

#### Scenario: Truncated response
- **WHEN** the model response is truncated or its stream does not complete
- **THEN** the core reports failure and does not execute partial arguments.

### Requirement: Native DeepSeek transport
The system SHALL call Chat Completions through native HTTP/SSE without Agent or model SDKs, defaulting to deepseek-flash, and retain reasoning_content when present.

#### Scenario: Fragmented SSE
- **WHEN** bytes or tool arguments span network chunks
- **THEN** the adapter reconstructs the complete response before exposing executable tools.

### Requirement: Controlled Bash execution
The system SHALL provide real Bash execution with output, exit status, cancellation, timeout and bounded model-visible output.

#### Scenario: Long running command
- **WHEN** the command exceeds its timeout or the user cancels
- **THEN** the process group is terminated and a non-success result is persisted.

#### Scenario: Long output
- **WHEN** output exceeds the visible limit
- **THEN** full output remains available in a local artifact and the result reports truncation and its path.

### Requirement: Session and context
The system SHALL persist messages, tool state and compaction metadata in JSONL, resume without replaying completed actions, and use optional project Skills.

#### Scenario: Interrupted tool
- **WHEN** loading finds a started tool without a result
- **THEN** the session exposes an unknown result for inspection and never automatically re-executes it.

#### Scenario: Context compaction
- **WHEN** completed history exceeds the context budget
- **THEN** old history is summarized without splitting tool pairs and the original transcript remains saved.

#### Scenario: No project memory
- **WHEN** the project has no project-memory Skill
- **THEN** ordinary coding tasks still run without creating a Project Memory directory.
