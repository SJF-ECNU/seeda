## ADDED Requirements

### Requirement: Respect existing network configuration
The CLI SHALL prefer explicit HTTP(S) proxy environment settings and otherwise discover static macOS HTTP(S) system proxies without changing system settings.

#### Scenario: Default macOS launch
- **WHEN** system HTTPS proxy is enabled and no explicit proxy environment is supplied
- **THEN** native fetch uses that proxy before model requests start.

#### Scenario: Explicit environment
- **WHEN** proxy environment settings are supplied
- **THEN** the CLI does not replace them with system settings.

#### Scenario: Network exceptions
- **WHEN** proxy exceptions are configured
- **THEN** they are preserved in supported NO_PROXY syntax.

### Requirement: Safe network errors
The adapter SHALL report a useful network failure with safe diagnostic codes without exposing credentials or provider response bodies.

#### Scenario: Connection failure
- **WHEN** native fetch fails before a response arrives
- **THEN** the user sees a network error and proxy advice rather than only fetch failed.
