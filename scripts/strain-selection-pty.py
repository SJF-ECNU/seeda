"""Exercise real seed selection, searching and cancellation in a PTY."""
import fcntl, json, os, pty, select, struct, subprocess, termios, time
from pathlib import Path
repo = Path(__file__).resolve().parent.parent
artifact = repo / '.seeda' / f'strain-picker-{int(time.time()*1000)}'
artifact.mkdir(parents=True)
env = os.environ.copy()
env.update(DEEPSEEK_API_KEY='', SEEDA_LIBRARY=str(artifact/'library'), SEEDA_HOME=str(artifact/'state'))
fixture = """
import {StrainLibrary} from './src/strains/library.ts';
import {VersionStore} from './src/versions/store.ts';
const library=await StrainLibrary.open(process.env.SEEDA_LIBRARY);
const origin=await library.ensureOrigin(process.cwd());
const store=await VersionStore.open(process.env.SEEDA_HOME+'-source');
const version=await store.initialize(origin.path);
const strain=await library.publish('fast-coding',store,version,'picker-fixture',{summary:'选择器测试样例',improvements:'用于交互测试',scenarios:'测试种系搜索',limitations:'测试数据，无性能声明',validation:'仅本地选择器验证'});
library.setDefault(strain.id); console.log(JSON.stringify({id:strain.id,origin:origin.id})); store.close();library.close();
"""
fixture = json.loads(subprocess.check_output(['node','--experimental-strip-types','--input-type=module','-'],input=fixture.encode(),cwd=repo,env=env))
master, slave = pty.openpty()
original = termios.tcgetattr(slave)
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,100,0,0))
output = bytearray(); proc = None

def until(check):
    end=time.time()+30
    while time.time()<end:
        if select.select([master],[],[],0.05)[0]: output.extend(os.read(master,65536))
        if check(): return
    raise AssertionError('Picker timeout')

def launch(command=True):
    child = subprocess.Popen([str(repo/'src/cli.ts')] + (['seed'] if command else []),cwd=repo,env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
    (artifact/'pid').write_text(str(child.pid))
    return child
try:
    proc=launch(False); until(lambda:'★ fast-coding'.encode() in output and '仅本地选择器验证'.encode() in output)
    os.write(master,b'\x1b'); proc.wait(timeout=5); assert proc.returncode!=0
    assert termios.tcgetattr(slave)==original
    import sqlite3
    canceled = sqlite3.connect(artifact/'state/state.db')
    assert canceled.execute('SELECT current_version FROM runtime_state').fetchone()[0] is None
    canceled.close()
    boundary=len(output);proc=launch();until(lambda:'★ fast-coding'.encode() in output[boundary:])
    os.write(master,b'origin');time.sleep(0.1);os.write(master,b'\r');until(lambda: proc.poll() is not None)
    assert proc.returncode==0
    assert termios.tcgetattr(slave)==original
    import sqlite3
    db=sqlite3.connect(artifact/'state/state.db')
    assert db.execute('SELECT strain_id FROM seed_origin').fetchone()[0]==fixture['origin']
    db.close()
    report={'status':'passed','checks':['default preselected','introduction displayed','Escape cancels','terminal restored','search selects alternate','selected strain persisted'],'chosen':'origin','default':'fast-coding'}
    (artifact/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(artifact/'report.json')
finally:
    (artifact/'terminal.bin').write_bytes(output)
    if proc and proc.poll() is None:
        proc.kill();proc.wait(timeout=5)
    os.close(master);os.close(slave)
