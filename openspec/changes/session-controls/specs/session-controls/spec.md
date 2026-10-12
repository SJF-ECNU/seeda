## ADDED Requirements
### Requirement: Explicit session selection
The runtime SHALL provide new, list and resume operations, persist the selected session, and retain it across worker version changes.
#### Scenario: Resume an existing conversation
- **WHEN** an idle user resumes a listed session
- **THEN** its original history replaces the frontend history and subsequent requests append only to that session
#### Scenario: Busy runtime
- **WHEN** a session switch is requested during execution
- **THEN** the switch is rejected without changing the current conversation
### Requirement: Manual context compaction
The Agent SHALL provide cancellable manual compaction without executing tools or deleting original messages.
#### Scenario: Compact below automatic threshold
- **WHEN** the user requests compaction of multiple completed turns
- **THEN** older history is summarized, the latest turn is retained, and the effective context persists on reopening
#### Scenario: Summary fails or is cancelled
- **WHEN** summarization fails or is cancelled
- **THEN** the original effective context remains available
