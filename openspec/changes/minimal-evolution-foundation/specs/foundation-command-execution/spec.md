## ADDED Requirements

### Requirement: Host selected execution environment
The same capable Agent version SHALL execute Bash commands through a host-selected local or Docker adapter without environment-specific source patches.

#### Scenario: Unavailable container
- **WHEN** the selected container cannot execute a command
- **THEN** execution reports failure and does not fall back to the host shell

#### Scenario: Model supplied environment override
- **WHEN** a model attempts to select arbitrary container mounts or privileged runtime options through Bash arguments
- **THEN** the request cannot change the host-selected execution boundary

### Requirement: Preserve candidate isolation and cancellation
Execution adapters SHALL preserve existing output limits, cancellation and cleanup guarantees, and isolated candidates SHALL NOT inherit the primary host execution channel.

#### Scenario: Cancel container command
- **WHEN** an active Docker command is cancelled
- **THEN** its container workload and descendants are stopped and cleanup evidence is available

#### Scenario: Candidate attempts host execution
- **WHEN** an isolated candidate attempts to use the primary execution channel
- **THEN** access is denied without an unsandboxed fallback
