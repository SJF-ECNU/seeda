"""Isolated Seeda stages, repeatable native evaluation, external model accounting.

No accumulated limits. The ongoing project retains its participant; only learning may read
explicit public evidence files. Credentials never enter the stage environment.
"""
from __future__ import annotations
import json, os, secrets, shutil, signal, sqlite3, subprocess, time
from pathlib import Path
from contextlib import closing
from urllib.parse import urlparse
from native_broker import NativeBroker
from docker_scope import DockerScope

ROOT = Path(__file__).resolve().parent

class RuntimeFailure(RuntimeError):
    def __init__(self, message, result=None):
        super().__init__(message)
        self.result = result

def save(path, value):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temp.replace(path)

class Runtime:
    def __init__(self, meter, node, seed_source, run_directory, model, root=ROOT, on_update=None, dependencies=None):
        self.meter, self.node, self.seed_source = meter, str(node), Path(seed_source)
        self.directory, self.root, self.model = Path(run_directory), Path(root).resolve(), model
        self.dependencies = Path(dependencies).resolve() if dependencies else None
        self.on_update = on_update or (lambda *_: None)
        self.active = None; self.broker = None; self.cancelled = False
        self.directory.mkdir(parents=True, exist_ok=True)

    def _signal_active(self, sig):
        process = self.active
        if not process or process.poll() is not None: return
        try: os.killpg(process.pid, sig)
        except ProcessLookupError: pass
        except PermissionError:
            # macOS can reject group signalling as the sandbox leader exits.
            # Popen rechecks/reaps this owned child before signalling its PID.
            process.send_signal(sig)

    def cancel(self):
        self.cancelled = True
        self._signal_active(signal.SIGTERM)

    def close(self):
        self.cancel()
        if self.broker: self.broker.close(); self.broker = None

    def run_stage(self, label, phase, prompt, participant, source=None, version=None,
                  evaluation=None, allowed_public_logs=(), score_url=None,
                  session_id=None, workspace_files=None, yield_request_path=None, yield_after_tools=(),
                  container=None, docker_socket=None, timeout_seconds=None):
        if phase not in ('solve', 'learn', 'decision', 'work'): raise ValueError('Invalid phase')
        if phase == 'solve' and allowed_public_logs:
            raise ValueError('Path A solve cannot inherit public history')
        if not label or Path(label).name != label: raise ValueError('Stage label must be a basename')
        if self.cancelled or self.meter.snapshot().get('stop_reason'):
            raise RuntimeFailure('Runtime cancelled or accounting stopped')
        participant = Path(participant).resolve()
        runtime, workspace, local = participant/'r', participant/'w'/label, participant/'s'/label
        if len(str(runtime/'control.sock').encode()) >= 104:
            raise ValueError('Participant path exceeds macOS control socket length; use a shorter run/participant path')
        if phase == 'solve' and (runtime/'state.db').exists() and not session_id:
            raise ValueError('Path A solve requires a fresh runtime')
        if session_id:
            # Explicit continuation belongs to this same episode/participant, never a previous task.
            candidates = list((participant/'s').glob('*/result.json'))
            prior = [json.loads(p.read_text()) for p in candidates]
            prior = [r for r in prior if r.get('session_id') == session_id]
            if not prior: raise ValueError('Same-episode session workspace unknown')
            workspace = Path(prior[-1]['workspace'])
        for path in (runtime, workspace, local): path.mkdir(parents=True, exist_ok=True)
        evidence = self.directory/'stages'/label; evidence.mkdir(parents=True, exist_ok=False)
        for name, text in (workspace_files or {}).items():
            target = (workspace/name).resolve()
            if not target.is_relative_to(workspace.resolve()): raise ValueError('Workspace file escapes workspace')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(text) if isinstance(text, bytes) else target.write_text(text)
        source = Path(source or (version or {}).get('runtime_path') or self.seed_source).resolve()
        url = self.meter.register(label, None, None, phase)
        meter_stage = self.meter.tokens[urlparse(url).path.split('/')[1]]
        spec = {'semaphorePrefix':'/sd-'+secrets.token_hex(8),'hostPath':str(source),'runtimeRoot':str(runtime),'workspace':str(workspace),
                'phase':phase,'sourcePath':str(source),'sourceVersion':version,'baseUrl':url,
                'model':self.model,'thinking':True,'execution':{'kind':'local'},'prompt':prompt,
                'resultPath':str(local/'result.json'),'eventsPath':str(local/'events.jsonl'),
                'timeoutMs':None if timeout_seconds is None else timeout_seconds * 1000}
        if self.dependencies: spec['dependenciesPath'] = str(self.dependencies)
        if score_url: spec['scoreUrl'] = score_url
        if yield_request_path:
            if phase != 'solve': raise ValueError('Experiment yield checkpoints belong to solve only')
            spec['yieldRequestPath'] = str(Path(yield_request_path).resolve())
        if yield_after_tools: spec['yieldAfterTools'] = list(yield_after_tools)
        if allowed_public_logs:
            paths = [Path(p).resolve() for p in allowed_public_logs]
            if any(not p.is_file() for p in paths): raise ValueError('Public evidence must be explicit existing files')
            spec['comparisonEvidencePaths'] = [str(p) for p in paths]
        if evaluation: spec['allowedEvaluationId'] = evaluation
        if session_id: spec.update(sessionId=session_id, resumeSession=True)
        if (runtime/'state.db').exists():
            with closing(sqlite3.connect(runtime/'state.db')) as db, closing(sqlite3.connect(evidence/'state-before.sqlite')) as backup:
                db.backup(backup)
        safe_env = {k:v for k,v in os.environ.items() if not any(x in k.upper() for x in ('KEY','TOKEN','SECRET','PASSWORD','PROXY'))}
        safe_env.update(PATH=str(Path(self.node).parent)+':/Library/Developer/CommandLineTools/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin',SEEDA_SYSTEM_PROXY='0',npm_config_offline='true')
        # Current source id is looked up in persistent native state. Initial learning
        # must be initialized by the runner before invoking evaluate, or supplied version.
        source_id = None
        if (runtime/'state.db').exists():
            with closing(sqlite3.connect(runtime/'state.db')) as db:
                row = db.execute('SELECT current_version FROM runtime_state WHERE id=1').fetchone()
                if row: source_id = row[0]
        scope = None
        broker = None; started = time.time(); before = self.meter.snapshot(); result = None
        try:
            if container:
                if not docker_socket: raise ValueError('Docker socket required for task scope')
                scope = DockerScope(str(docker_socket), container, evidence/'docker-api.jsonl').start()
                spec.update(execution={'kind':'docker','container':container,'cwd':'/workspace'}, dockerHost=scope.url, commandProofPath=str(scope.proof_path))
            if phase in ('learn', 'work'):
                (evidence/'native-evaluate').mkdir()
                spec['nativeEvidenceRoot'] = str(evidence/'native-evaluate')
                broker = NativeBroker(self.node,self.root,runtime,workspace,source_id,url,self.model,evidence/'native-evaluate',safe_env,host_path=str(self.seed_source.resolve()),thinking=True,dynamic_source=phase=='work',dependencies=self.dependencies,task_container=container,docker_socket=docker_socket).start()
                spec['nativeEvaluateUrl'] = broker.url; spec['nativeValidationHost'] = str(self.seed_source.resolve()); self.broker = broker
            save(local/'input.json',spec)
            script = "import {readFileSync} from 'node:fs';import {stageProfile} from './stage.ts';const s=JSON.parse(readFileSync(process.argv[1],'utf8'));console.log(stageProfile(s,[process.argv[1],process.env.HOME+'/.npm/_cacache']));"
            built = subprocess.run([self.node,'--experimental-strip-types','--input-type=module','-e',script,str(local/'input.json')],cwd=self.root,env=safe_env,capture_output=True,text=True)
            if built.returncode: raise RuntimeFailure('Sandbox profile creation failed: '+built.stderr[-4000:])
            (local/'profile.sb').write_text(built.stdout)
            self.on_update({'label':label,'phase':phase,'started':started,'workspace':str(workspace)})
            with (evidence/'process.log').open('w') as output:
                self.active = subprocess.Popen(['/usr/bin/sandbox-exec','-f',str(local/'profile.sb'),self.node,'--experimental-strip-types',str(self.root/'stage.ts'),str(local/'input.json')],cwd=workspace,env=safe_env,stdout=output,stderr=subprocess.STDOUT,start_new_session=True)
                cancelled_at = None
                while self.active.poll() is None:
                    if self.cancelled or self.meter.snapshot().get('stop_reason'):
                        if cancelled_at is None:
                            cancelled_at = time.time()
                            self._signal_active(signal.SIGTERM)
                        elif time.time()-cancelled_at > 15:
                            self._signal_active(signal.SIGKILL)
                    time.sleep(.25)
            try:
                result = json.loads((local/'result.json').read_text()) if (local/'result.json').exists() else {'execution_status':'failed','error':'stage_failed_without_result'}
            except (ValueError, OSError):
                result = {'execution_status':'failed','error':'stage_result_missing_or_incomplete','raw_result_path':str(local/'result.json')}
            result.update(native_validation_host=str(self.seed_source.resolve()) if phase in ('learn','work') else None, requested_source=str(source), imported_version=result.get('version_before'), stage_id=label,wall_seconds=time.time()-started,process_exit_code=self.active.returncode,transport_before=before,transport_after=self.meter.snapshot(),evidence_directory=str(evidence))
            save(evidence/'result.json',result)
            if (local/'events.jsonl').exists(): shutil.copy2(local/'events.jsonl',evidence/'events.jsonl')
            if result.get('execution_status') not in ('completed', 'budget_exhausted') or result['process_exit_code'] != 0 or result.get('execution_failure') or result.get('cleanup_error') or self.meter.snapshot().get('stop_reason'):
                raise RuntimeFailure('Stage did not complete with valid execution/accounting',result)
            for registered in result.get('versions',[]):
                check = subprocess.run(['git','-C',registered['runtime_path'],'status','--porcelain','--untracked-files=no'],capture_output=True,text=True)
                if check.returncode or check.stdout: raise RuntimeFailure('Registered version changed in place',result)
            return result
        except BaseException as error:
            self.cancelled=True
            save(evidence/'failure.json',{'error':str(error),'wall_seconds':time.time()-started,'transport_before':before,'transport_after':self.meter.snapshot()})
            raise
        finally:
            if self.active and self.active.poll() is None:
                self._signal_active(signal.SIGTERM)
                try: self.active.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    self._signal_active(signal.SIGKILL)
                    self.active.wait(timeout=5)
            self.active = None
            if broker: broker.close()
            if scope: scope.close()
            self.broker = None
            with self.meter.lock: self.meter.stages[meter_stage]['closed'] = True
            self.on_update(None)
