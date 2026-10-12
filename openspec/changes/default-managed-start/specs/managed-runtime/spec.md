## ADDED Requirements
### Requirement: Managed default launch
The default CLI SHALL initialize missing runtime state, start a background supervisor when absent, and connect to a ready primary with RSI tools.
#### Scenario: First npm start
- **WHEN** no managed runtime exists
- **THEN** it is initialized and started automatically before entering the frontend
#### Scenario: Reopen frontend
- **WHEN** a ready supervisor serves the same workspace
- **THEN** it is reused with the retained session and no second primary
#### Scenario: Concurrent first starts
- **WHEN** two frontends launch simultaneously
- **THEN** one supervisor initializes and both observe that same primary
#### Scenario: Startup failure
- **WHEN** initialization or worker startup fails
- **THEN** launch reports the failure without falling back to a non-RSI Agent
#### Scenario: Explicit direct mode
- **WHEN** SEEDA_MANAGED is 0
- **THEN** the CLI uses the original direct core without starting a supervisor
