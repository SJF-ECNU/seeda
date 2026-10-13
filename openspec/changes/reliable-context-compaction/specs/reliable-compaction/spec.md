## ADDED Requirements
### Requirement: Early automatic compaction
The Agent SHALL automatically compact before its next model request when input occupancy reaches 85 percent of its configured total window or reserved input capacity, whichever is smaller.
#### Scenario: Threshold reached
- **WHEN** measured or estimated input occupancy reaches the threshold
- **THEN** the Agent compacts and continues without user confirmation
### Requirement: Bounded continuation summaries
Summary requests SHALL fit their estimated input budget and retain continuation facts across batches. The original session SHALL remain unchanged unless all summaries and final context validation succeed.
#### Scenario: Oversized old tool result
- **WHEN** old history contains a tool result larger than a summary request
- **THEN** summary material is processed in bounded fragments and the original record remains available
#### Scenario: Summary fails
- **WHEN** any summary is incomplete, oversized, cancelled or rejected
- **THEN** the original effective context remains intact
