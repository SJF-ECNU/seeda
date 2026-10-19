import tempfile
import json
import unittest
from pathlib import Path
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from wb_harbor import inspect_result, prepare_task, _CALLBACKS, CallbackAgent
from harbor.agents.factory import AgentFactory
from harbor.models.trial.config import AgentConfig
import tomllib


class ResultTests(unittest.TestCase):
    def test_official_factory_loads_callback_agent(self):
        async def callback(instruction, environment, context):
            pass
        _CALLBACKS["factory-test"] = callback
        try:
            config = AgentConfig(import_path="wb_harbor:CallbackAgent", model_name="deepseek-flash", kwargs={"callback_id": "factory-test"})
            with tempfile.TemporaryDirectory() as tmp:
                agent = AgentFactory.create_agent_from_config(config, logs_dir=Path(tmp))
                self.assertIsInstance(agent, CallbackAgent)
                self.assertIs(agent.callback, callback)
                self.assertEqual(agent.to_agent_info().name, "seeda-host-callback")
        finally:
            _CALLBACKS.pop("factory-test", None)

    def test_owned_network_restores_on_failure_and_cancel(self):
        async def run(error_type, verifier_mode):
            connected = {'owned-net': {'Aliases': ['main'], 'IPAMConfig': None}}
            events = []
            async def docker(*args):
                events.append(args)
                if args[0] == 'inspect':
                    return json.dumps([{'NetworkSettings': {'Networks': dict(connected)}}])
                if args[1] == 'disconnect':
                    connected.pop(args[2])
                elif args[1] == 'connect':
                    connected[args[-2]] = {'Aliases': ['main']}
                return ''
            async def callback(*args):
                self.assertFalse(connected)
                raise error_type()
            _CALLBACKS['network-test'] = callback
            try:
                with tempfile.TemporaryDirectory() as tmp:
                    agent = CallbackAgent(logs_dir=Path(tmp), callback_id='network-test', verifier_network_mode=verifier_mode)
                    with patch('wb_harbor.container_id', new=AsyncMock(return_value='exact-owned-cid')), patch('wb_harbor.docker_command', new=docker):
                        with self.assertRaises(error_type):
                            await agent.run('task', object(), object())
                    self.assertEqual(bool(connected), verifier_mode != 'no-network')
                    self.assertTrue(all(args[-1] == 'exact-owned-cid' for args in events))
            finally:
                _CALLBACKS.pop('network-test', None)
        for error in (RuntimeError, asyncio.CancelledError):
            for mode in ('public', 'no-network'):
                asyncio.run(run(error, mode))

    def test_setup_protects_only_verifier_paths_and_public_artifacts(self):
        async def run():
            environment = SimpleNamespace(exec=AsyncMock(return_value=SimpleNamespace(return_code=0)))
            with tempfile.TemporaryDirectory() as tmp:
                _CALLBACKS["setup-test"] = AsyncMock()
                try:
                    agent = CallbackAgent(logs_dir=Path(tmp), callback_id="setup-test")
                    with patch("wb_harbor.ensure_agent_user", new=AsyncMock()):
                        await agent.setup(environment)
                    calls = environment.exec.call_args_list
                    self.assertEqual(calls[0].kwargs['command'], 'mkdir -p /logs/artifacts && chown dev /logs/artifacts')
                    self.assertIn('/scorer /tests /solution', calls[1].kwargs['command'])
                    self.assertNotIn('/logs/verifier', calls[1].kwargs['command'])
                    self.assertEqual(calls[2].kwargs['user'], 'dev')
                    environment.exec.return_value.return_code = 1
                    with patch("wb_harbor.ensure_agent_user", new=AsyncMock()):
                        with self.assertRaises(RuntimeError):
                            await agent.setup(environment)
                finally:
                    _CALLBACKS.pop("setup-test", None)
        asyncio.run(run())

    def test_zero_product_is_valid(self):
        result = {"verifier_result": {"rewards": {"reward": 0}}}
        self.assertTrue(inspect_result(result, {"test_status": "no_pass"}, composite=True)["valid"])

    def test_judge_error_is_not_zero(self):
        result = {"verifier_result": {"rewards": {"reward": 0}}}
        for score in ({"test_status": "judge_error"}, {"judges": [{"verdicts": [{"status": "judge_error"}]}]}, {"diagnostics": {"engine_error": "offline"}}):
            self.assertFalse(inspect_result(result, score, composite=True)["valid"])

    def test_model_stage_failures_invalid_but_unneeded_stages_valid(self):
        result = {"verifier_result": {"rewards": {"reward": 0.5}}}
        for stage in ({"name": "llm_judge", "exit_code": 1}, {"name": "agent_judge", "skipped": True, "reason": "client unavailable"}, {"name": "rule", "exit_code": 127, "error": "exec failed"}):
            self.assertFalse(inspect_result(result, {"stages": [stage]}, composite=True)["valid"])
        score = {"stages": [{"name": "llm_judge", "skipped": True, "reason": "no llm/vlm judge items", "exit_code": 0}, {"name": "rule", "exit_code": 1}]}
        self.assertTrue(inspect_result(result, score, composite=True)["valid"])

    def test_missing_corrupt_and_exception_invalid(self):
        for result in ({}, {"verifier_result": {"rewards": {"reward": float('nan')}}}, {"exception_info": {"exception_type": "Failure"}, "verifier_result": {"rewards": {"reward": 1}}}):
            self.assertFalse(inspect_result(result, None, composite=False)["valid"])
        self.assertFalse(inspect_result({"verifier_result": {"rewards": {"reward": 1}}}, None, composite=True)["valid"])

    def test_security_native_does_not_require_composite_score(self):
        self.assertTrue(inspect_result({"verifier_result": {"rewards": {"reward": 1}}}, None, composite=False)["valid"])

    def test_prepare_isolated_real_task(self):
        source = Path(__file__).parent / 'upstream/datasets/wb-bench-code-v1.0/tasks/bug_fix-easy-filtered_relation_queryset_arg'
        with tempfile.TemporaryDirectory() as tmp:
            task = prepare_task(source, Path(tmp) / 'prepared')
            self.assertEqual([p.name for p in task.parent.iterdir()], [source.name])
            original = tomllib.loads((source / 'task.toml').read_text())
            prepared = tomllib.loads((task / 'task.toml').read_text())
            self.assertEqual(original['environment']['network_mode'], prepared['environment']['network_mode'])
            self.assertEqual(original['environment']['cpus'], prepared['environment']['cpus'])
            self.assertNotIn('network_mode', prepared['agent'])
            self.assertTrue((task.parent.parent / 'effective-policy.json').exists())
            from harbor.models.task.config import TaskConfig
            TaskConfig.model_validate(prepared)
            self.assertTrue((task.parent.parent / 'shared/verifier/plugin.py').is_file())
            self.assertIn('user = "dev"', (task / 'task.toml').read_text())
            self.assertNotIn('user = "dev"', (source / 'task.toml').read_text())

    def test_security_phase_removal_preserves_toml_newlines(self):
        source = Path(__file__).parent / 'upstream/datasets/wb-bench-sec-v1.0/tasks/linux-ld-preload-investigation'
        with tempfile.TemporaryDirectory() as tmp:
            task = prepare_task(source, Path(tmp) / 'prepared')
            data = tomllib.loads((task / 'task.toml').read_text())
            self.assertEqual(data['verifier']['timeout_sec'], 240)
            self.assertNotIn('network_mode', data['agent'])
            self.assertNotIn('network_mode', data['verifier'])


if __name__ == '__main__':
    unittest.main()
