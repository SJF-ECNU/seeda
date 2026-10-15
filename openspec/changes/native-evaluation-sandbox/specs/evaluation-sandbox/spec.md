## ADDED Requirements

### Requirement: Mandatory sandbox execution
The supervisor SHALL start every candidate evaluation inside a host-controlled sandbox before loading candidate code and SHALL apply restrictions to descendant processes.

#### Scenario: Candidate requests no isolation
- **WHEN** an evaluation specifies none or an unknown sandbox backend
- **THEN** the supervisor rejects the request without loading the candidate

#### Scenario: Backend cannot start
- **WHEN** the requested backend is unavailable or isolation setup fails
- **THEN** evaluation fails explicitly without unsandboxed fallback

### Requirement: Agent-selected backend
The management interface SHALL accept process or container as the sandbox selection and SHALL use process when omitted for existing callers.

#### Scenario: Lightweight prompt evaluation
- **WHEN** the caller selects process on a supported host without Docker
- **THEN** the evaluation executes within the operating system sandbox without requiring a container daemon

#### Scenario: Container environment required
- **WHEN** the caller selects container
- **THEN** candidate preparation and execution use an isolated Linux environment without host native dependencies or unrestricted host mounts

### Requirement: Host-owned authority and evidence
The host SHALL control sandbox policy, lifecycle and final evidence, SHALL deny candidate access to live runtime state and control sockets, and SHALL NOT trust candidate-reported process identifiers as host signal targets.

#### Scenario: Candidate forges a process message
- **WHEN** a candidate reports an arbitrary host process identifier
- **THEN** the host does not signal that identifier and reclaims only resources it owns

#### Scenario: Candidate tries to manage evolution
- **WHEN** candidate code accesses management messages or the production control socket
- **THEN** it cannot mutate supervisor version state through either path

### Requirement: Restricted resources and external access
The sandbox SHALL restrict filesystem and network access, SHALL NOT inherit host credentials, and SHALL bound execution time and retained output. Container execution SHALL also bound CPU, memory and process count.

#### Scenario: Model-backed evaluation
- **WHEN** a candidate needs model inference
- **THEN** it receives only the permitted model capability without access to host long-lived credentials or arbitrary network forwarding

#### Scenario: Resource cleanup
- **WHEN** evaluation completes, fails, times out, is cancelled, or its supervisor exits
- **THEN** sandbox workloads are terminated and owned execution resources are reclaimed, with recovery verified after supervisor interruption
