# WorkBuddy research harness snapshot

This optional harness stays outside Seeda core. It records the four-domain pilot adapter used in the local `workbuddy-seeda-evolution` workspace; it is not an official leaderboard submission or a new application subsystem.

Install the upstream Tencent WorkBuddy repository (recorded revision in config.json) under `upstream`, with its Harbor 0.18.0 environment and downloaded four datasets. Set `config.json.seed_source` to the verified installed Seeda release. The manifest contains local operator paths; select tasks using the public selection-proposal.json. Its heldout entries must remain inaccessible to the learner. Preserve prior run ledgers when relocating.

Use Node 24.14+, Docker Desktop and Python from upstream/.venv. Supply existing DEEPSEEK_API_KEY and DASHSCOPE_API_KEY only through the environment. Never put credentials in config, images, source snapshots or logs. Run `launch.py --id NEW_ID` only with explicit experiment authorization. Provider and judge meters keep independent ledgers; unknown usage is not zero. Qwen3-vl-plus is an explicit judge override, not an official ranking claim. config.json currently documents fixed runner settings except the seed source, which is read directly.

Candidate code stays in its native sandbox. Trusted candidate commands use a separate offline same-image container, nonroot UID, no mounts or scorer access, through the existing scoped Docker adapter; the live task container is never shared. Capability container/probe failure and model transport/unknown usage stop the run; product failures remain valid feedback. Containers, ledgers and artifacts remain for audit. Source snapshots and publication evidence are kept in the operator workspace rather than committed generated artifacts.
