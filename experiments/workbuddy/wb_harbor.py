"""Host callback agent using the unmodified WorkBuddy Harbor lifecycle/verifier.

Callbacks receive only instruction, task environment and AgentContext. Tests and
reference assets remain host-side until Harbor starts the verifier phase.
"""
from __future__ import annotations

import json
import asyncio
import subprocess
import math
import shlex
import re
import traceback
import shutil
import tomllib
from pathlib import Path
from typing import Any, Awaitable, Callable
from uuid import uuid4

from harbor.agents.base import BaseAgent
from harbor.models.trial.config import TrialConfig
from harbor.trial.trial import Trial
from workbuddy_bench.agents._agent_user import ensure_agent_user
from workbuddy_bench.runner.prepare_tasks import (
    ensure_composite_verifier_contract,
    ensure_host_gateway_compose,
    ensure_task_user,
)

from workbuddy_bench.judge import CompositeVerifier

class AuditedCompositeVerifier(CompositeVerifier):
    """Independent execution evidence; official scoring itself stays unchanged."""
    async def probe(self):
        dataset = tomllib.loads((self.task.paths.task_dir.parent.parent / 'dataset.toml').read_text())['dataset']['id']
        modules = []
        recipe = self.task.paths.tests_dir / 'verifier.toml'
        if 'code' in dataset and recipe.exists() and tomllib.loads(recipe.read_text()).get('family') == 'pytest_injected':
            modules = ['pytest']
        program = "import importlib,tempfile,subprocess; f=tempfile.TemporaryFile(); f.write(b'ok'); f.close(); subprocess.run(['/bin/true'],check=True); " + '; '.join('m=importlib.import_module('+repr(m)+'); assert callable(m.main)' for m in modules)
        result = await self.environment.exec('python3 -I -c '+shlex.quote(program),cwd='/tmp',user='root',timeout_sec=15)
        path = self.trial_paths.verifier_dir / 'execution-probes.json'
        rows = json.loads(path.read_text()) if path.exists() else []
        rows.append(result.model_dump());path.write_text(json.dumps(rows,indent=2))
        if result.return_code != 0:
            raise RuntimeError('Trusted verifier execution/dependency probe failed')
    async def verify(self):
        await self.probe()
        result = await super().verify()
        await self.probe()
        return result

Callback = Callable[[str, Any, Any], Awaitable[None]]
_CALLBACKS: dict[str, Callback] = {}


class CallbackAgent(BaseAgent):
    def __init__(self, *args, callback_id: str, verifier_network_mode: str = "public", **kwargs):
        super().__init__(*args, **kwargs)
        self.callback = _CALLBACKS[callback_id]
        self.verifier_network_mode = verifier_network_mode

    @staticmethod
    def name() -> str:
        return "seeda-host-callback"

    def version(self) -> str:
        return "1"

    async def exec_as_root(self, environment, **kwargs):
        result = await environment.exec(user="root", **kwargs)
        if result.return_code != 0:
            raise RuntimeError(f"Agent user setup failed: {result}")
        return result

    async def setup(self, environment) -> None:
        await ensure_agent_user(self, environment)
        await self.exec_as_root(environment, command="mkdir -p /logs/artifacts && chown dev /logs/artifacts")
        await self.exec_as_root(environment, command=(
            "for p in /scorer /tests /solution; do "
            "if [ -e \"$p\" ]; then chown -R root:root \"$p\" && chmod -R go-rwx \"$p\" || exit; fi; done"
        ))
        result = await environment.exec(command=(
            "test \"$(id -u)\" != 0 && "
            "for p in /scorer /tests /solution; do "
            "if [ -e \"$p\" ] && [ -r \"$p\" ]; then exit 1; fi; done"
        ), user="dev")
        if result.return_code != 0:
            raise RuntimeError("Agent can read protected verifier paths or runs as root")

    async def run(self, instruction, environment, context) -> None:
        cid = await container_id(environment)
        networks = json.loads(await docker_command("inspect", cid))[0]["NetworkSettings"]["Networks"]
        record = {"container_id": cid, "original_networks": networks,
                  "agent_policy": "owned Docker disconnect", "verifier_policy": self.verifier_network_mode}
        record_path = self.logs_dir / "network-policy.json"
        record_path.write_text(json.dumps(record, indent=2))
        try:
            for network in networks:
                await docker_command("network", "disconnect", network, cid)
            current = json.loads(await docker_command("inspect", cid))[0]["NetworkSettings"]["Networks"]
            if current:
                raise RuntimeError("Agent container remains connected")
            record["agent_disconnected"] = True
            record_path.write_text(json.dumps(record, indent=2))
            await self.callback(instruction, environment, context)
        finally:
            if self.verifier_network_mode != "no-network":
                # Restore all original attachments, including after partial failure.
                current = json.loads(await asyncio.shield(docker_command("inspect", cid)))[0]["NetworkSettings"]["Networks"]
                for network, endpoint in networks.items():
                    if network in current:
                        continue
                    args = ["network", "connect"]
                    for alias in endpoint.get("Aliases") or []:
                        args += ["--alias", alias]
                    for key, flag in (("IPv4Address", "--ip"), ("IPv6Address", "--ip6")):
                        address = (endpoint.get("IPAMConfig") or {}).get(key)
                        if address:
                            args += [flag, address]
                    await asyncio.shield(docker_command(*args, network, cid))
                restored = json.loads(await asyncio.shield(docker_command("inspect", cid)))[0]["NetworkSettings"]["Networks"]
                if set(restored) != set(networks):
                    raise RuntimeError("Verifier original networks not restored")
                record["verifier_restored"] = True
            else:
                record["verifier_remains_offline"] = True
            record_path.write_text(json.dumps(record, indent=2))



def prepare_task(task: Path, destination: Path, *, verifier_user: str = "root") -> Path:
    """Copy one task plus dataset shared runtime, then apply official preparation.

    Destination must not exist. Other tasks, including heldouts, are not copied.
    The complete prepared directory is trusted host control, never learner mount.
    """
    task = task.resolve(strict=True)
    dataset = task.parent.parent
    destination.mkdir(parents=True, exist_ok=False)
    for child in dataset.iterdir():
        if child.name == "tasks":
            continue
        target = destination / child.name
        if child.is_dir():
            shutil.copytree(child, target, symlinks=True)
        else:
            shutil.copy2(child, target)
    prepared = destination / "tasks" / task.name
    shutil.copytree(task, prepared, symlinks=True)
    config_path = prepared / "task.toml"
    text = config_path.read_text()
    data = tomllib.loads(text)
    if data.get("steps"):
        raise ValueError("Step-level network overrides need explicit review")
    original = {role: {key: data.get(role, {}).get(key) for key in ("network_mode", "allowed_hosts")}
                for role in ("agent", "verifier")}
    verifier_mode = original["verifier"]["network_mode"] or data.get("environment", {}).get("network_mode", "public")
    if verifier_mode not in ("public", "no-network"):
        raise ValueError("Docker attachment adapter cannot enforce verifier allowlists")
    for role in ("agent", "verifier"):
        match = re.search(rf"(?m)^\[{role}\][ \t]*$", text)
        if match:
            next_table = re.search(r"(?m)^\[", text[match.end():])
            end = match.end() + next_table.start() if next_table else len(text)
            section = re.sub(r"(?m)^[ \t]*(?:network_mode|allowed_hosts)[ \t]*=[^\n]*(?:\n|$)", "", text[match.end():end])
            text = text[:match.end()] + section + text[end:]
    config_path.write_text(text)
    (destination / "effective-policy.json").write_text(json.dumps({
        "original_phase_policies": original, "agent_policy": "owned Docker disconnect",
        "verifier_network_mode": verifier_mode, "custom_environment_adapter": True
    }, indent=2))
    ensure_host_gateway_compose(prepared)
    ensure_composite_verifier_contract(prepared)
    ensure_task_user(prepared, agent_user="dev", verifier_user=verifier_user)
    return prepared


def inspect_result(result: dict, score: dict | None, *, composite: bool, probes: list | None = None) -> dict:
    """Retain official score while keeping verifier failures distinct from zero."""
    errors = []
    if result.get("exception_info"):
        errors.append({"trial_exception": result["exception_info"]})
    rewards = (result.get("verifier_result") or {}).get("rewards")
    if not isinstance(rewards, dict) or not rewards:
        errors.append("Missing official rewards")
    elif any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v)
             for v in rewards.values()):
        errors.append("Invalid official reward payload")
    if composite and score is None:
        errors.append("Missing composite score.json")

    healthy = bool(probes) and len(probes) == 2 and all(p.get('return_code') == 0 for p in probes)
    raw = json.dumps(score,ensure_ascii=False) if score is not None else ''
    candidate_trace = bool(re.search(r'/workspace/(?!tests/)[^"\\\n ]+\.py', raw)) and any(x in raw for x in ('SyntaxError','IndentationError','TabError'))
    product_build_failure = healthy and candidate_trace
    def visit(value):
        if isinstance(value, dict):
            # Rule assertions may fail normally; failed/skipped model-judge
            # stages and explicit execution errors are not product scores.
            name = str(value.get("name") or value.get("type") or "").lower()
            model_stage = any(token in name for token in ("llm", "vlm", "agent_judge"))
            reason = str(value.get("reason") or "").lower()
            if model_stage and value.get("skipped") and not reason.startswith("no "):
                errors.append({"skipped_model_judge": value})
            if model_stage and value.get("exit_code", 0) != 0:
                errors.append({"failed_model_judge": value})
            if value.get("error") and ("exit_code" in value or model_stage):
                errors.append({"stage_error": value})
            if value.get("client_failed") or value.get("client_error"):
                errors.append({"judge_client_error": value})
            for key, item in value.items():
                if key in {"test_status", "status"} and (item == "judge_error" or (item == "build_error" and not product_build_failure)):
                    errors.append({key: item})
                if key in {"engine_error", "exception_type"} and item:
                    errors.append({key: item})
                visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)
    if score is not None:
        visit(score)
    return {"valid": not errors, "rewards": rewards, "infrastructure_errors": errors,
            "official_result": result, "official_score": score, "execution_probes": probes, "candidate_build_failure": product_build_failure}


async def docker_command(*args: str) -> str:
    operation = asyncio.create_task(asyncio.to_thread(subprocess.run, ["docker", *args], capture_output=True, text=True, timeout=30))
    try:
        result = await asyncio.shield(operation)
    except asyncio.CancelledError:
        # Finish the bounded operation before restoration, avoiding a late
        # disconnect racing with cancellation cleanup.
        await asyncio.shield(operation)
        raise
    if result.returncode:
        raise RuntimeError(f"Owned Docker operation failed {args}: {result.stderr}")
    return result.stdout


async def container_id(environment) -> str:
    """Resolve only this Harbor Compose project's main container."""
    result = await environment._run_docker_compose_command(["ps", "-q", "main"])
    ids = (result.stdout or "").split()
    if result.return_code != 0 or len(ids) != 1:
        raise RuntimeError(f"Unable to resolve owned main container: {result}")
    return ids[0]


async def release_stopped_networks(project: str, record_path: Path):
    """Release only this stopped trial's networks; retained containers stay intact."""
    listing = await docker_command('network','ls','--filter','label=com.docker.compose.project='+project,'--format','{{.ID}}')
    records=[]
    for network in listing.split():
        data=json.loads(await docker_command('network','inspect',network))[0]
        for cid in data.get('Containers',{}):
            container=json.loads(await docker_command('inspect',cid))[0]
            if container['State']['Running']:
                raise RuntimeError('Refusing to release network with running trial container')
            await docker_command('network','disconnect','-f',network,cid)
        await docker_command('network','rm',network)
        records.append(data)
    record_path.write_text(json.dumps(records,indent=2))


async def run_trial(task: Path, output: Path, callback: Callback, *,
                    verifier_env: dict[str, str] | None = None,
                    agent_timeout_sec: float | None = None,
                    verifier_timeout_sec: float | None = None,
                    model_name: str = "deepseek-flash") -> dict:
    """Run one prepared official task, preserving stopped containers and records.

    No provider calls are made by this adapter itself. Agent and judge costs must
    be recorded by their respective transport. Cancellation propagates after
    Harbor's official cleanup. A returned valid=False must stop orchestration.
    """
    task, output = task.resolve(strict=True), output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    dataset = tomllib.loads((task.parent.parent / "dataset.toml").read_text())
    composite = (dataset.get("verifier") or {}).get("engine") == "composite"
    callback_id = str(uuid4())
    _CALLBACKS[callback_id] = callback
    config = TrialConfig.model_validate({
        "task": {"path": str(task)}, "trial_name": f"wb-{output.name}-{callback_id[:8]}", "trials_dir": str(output),
        "timeout_multiplier": 2.0,
        "agent": {"import_path": "wb_harbor:CallbackAgent", "model_name": model_name,
                  "override_timeout_sec": agent_timeout_sec,
                  "kwargs": {"callback_id": callback_id, "verifier_network_mode": json.loads((task.parent.parent / "effective-policy.json").read_text())["verifier_network_mode"]}},
        "environment": {"type": "docker", "import_path":
            "workbuddy_bench.runner.docker_environment:WorkBuddyDockerEnvironment",
            "delete": False, "force_build": False, "kwargs": {"keep_containers": True}},
        "verifier": {"import_path": "wb_harbor:AuditedCompositeVerifier" if composite else None,
                     "env": verifier_env or {}, "override_timeout_sec": verifier_timeout_sec},
    })
    try:
        trial = await Trial.create(config)
        result = await trial.run()
        payload = json.loads(result.model_dump_json())
        score_path = trial.paths.verifier_dir / "score.json"
        score = json.loads(score_path.read_text()) if score_path.exists() else None
        probe_path = trial.paths.verifier_dir / 'execution-probes.json'
        probes = json.loads(probe_path.read_text()) if probe_path.exists() else None
        audit = inspect_result(payload, score, composite=composite, probes=probes)
        (output / "audit.json").write_text(json.dumps(audit, indent=2))
        return audit
    except BaseException:
        (output / "adapter-exception.txt").write_text(traceback.format_exc())
        raise
    finally:
        _CALLBACKS.pop(callback_id, None)
        await release_stopped_networks(config.trial_name+'__env', output/'released-networks.json')
