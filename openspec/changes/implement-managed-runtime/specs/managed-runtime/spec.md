## ADDED Requirements
### Requirement: Retained implementation versions
The manager SHALL retain Git commits and separate dependency directories for registered versions and SHALL store growth metadata in SQLite.
#### Scenario: Return to a previous version
- **WHEN** a retained version is selected
- **THEN** its existing environment is reused and user session history remains intact
### Requirement: Independent survival recovery
The supervisor SHALL monitor ready, process exits and heartbeat without judging output quality and SHALL NOT replay interrupted requests.
#### Scenario: Current version crashes
- **WHEN** the current worker exits unexpectedly
- **THEN** the previous version is restored, or the first version is restarted with bounded retries
### Requirement: Candidate evaluation and handover
The manager SHALL run one candidate with an independent session and workspace, retain evidence and Agent decisions, and switch at a completed request boundary.
#### Scenario: A accepts B
- **WHEN** A records acceptance of a completed B evaluation and requests handover
- **THEN** B becomes the only routed primary at the request boundary and A stops
