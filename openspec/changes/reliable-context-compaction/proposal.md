## Why
Reliable waits until its full input budget is exhausted and sends all old history in one summary request. A large tool result can overflow even the summary request.
## What Changes
- Trigger automatic compaction at 85% of the configured context window, capped by reserved output capacity.
- Use continuation-focused summaries, bounded sequential summary requests and atomic context replacement.
- Preserve current user instructions, recent complete tool exchanges and original session records.
## Capabilities
### New Capabilities
- `reliable-compaction`: bounded automatic and manual context compaction.
### Modified Capabilities
## Impact
Agent core and compaction tests; no runtime replacement or release-library overwrite.
