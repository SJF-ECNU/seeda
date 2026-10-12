"""Exercise the real terminal adapter through a PTY. No model credentials needed."""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path

root = Path(__file__).resolve().parent.parent
automatic = '--auto' in sys.argv
managed = '--managed' in sys.argv or automatic
live = '--live' in sys.argv or managed
daemon = None
artifact = root / '.seeda' / f'tui-{"live" if live else "pty"}-{int(time.time() * 1000)}'
artifact.mkdir(parents=True)
master, slave = pty.openpty()
original = termios.tcgetattr(slave)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
env = os.environ.copy()
env['SEEDA_LIBRARY'] = str(artifact / 'library')
env['SEEDA_TUI_TEST_DIR'] = str(artifact)
program = root / ('src/cli.ts' if live else 'tests/fixtures/tui.ts')
env['SEEDA_SESSION'] = str(artifact / 'session.jsonl')
if live and not managed:
    env['SEEDA_MANAGED'] = '0'
if managed:
    env['SEEDA_HOME'] = str(artifact / 'state')
    env['SEEDA_MANAGED'] = '1'
if automatic:
    env.pop('SEEDA_MANAGED', None)
if managed and not automatic:
    subprocess.run(['node', '--experimental-strip-types', str(root / 'src/runtime/cli.ts'), 'init', str(root)], env=env, check=True, stdout=subprocess.DEVNULL)
    daemon = subprocess.Popen(['node', '--experimental-strip-types', str(root / 'src/runtime/cli.ts'), 'serve', str(artifact)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert select.select([daemon.stdout], [], [], 20)[0], 'Supervisor did not become ready'
    assert b'seeda supervisor:' in daemon.stdout.readline(), 'Supervisor startup failed'

proc = subprocess.Popen(['npm', 'start'] if automatic else ['node', '--use-env-proxy', '--experimental-strip-types', str(program)], cwd=root if automatic else artifact if live else root,
                        env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
output = bytearray()

def wait_for(text, timeout=10, offset=0):
    deadline = time.monotonic() + timeout
    needle = text.encode()
    while time.monotonic() < deadline:
        if needle in output[offset:]:
            return
        ready, _, _ = select.select([master], [], [], .05)
        if ready:
            try:
                part = os.read(master, 65536)
            except OSError:
                break
            output.extend(part)
        if proc.poll() is not None:
            break
    raise AssertionError(f'Terminal did not display {text!r}')

def send(text):
    os.write(master, text.encode())

try:
    wait_for('就绪')
    assert not termios.tcgetattr(slave)[3] & termios.ICANON
    if live:
        offset = len(output)
        send('请用 Bash 执行 printf tui-live-ok，然后用中文简短说明结果。\r')
        wait_for('Bash · 完成', timeout=90, offset=offset)
        wait_for('就绪', timeout=90, offset=offset)
        if managed:
            import sqlite3
            with sqlite3.connect(artifact / 'state/state.db') as db:
                current = db.execute('SELECT current_version FROM runtime_state WHERE id=1').fetchone()[0]
            offset = len(output)
            send('/versions\r')
            wait_for(current, offset=offset)
    else:
        send('你好🙂\r')
        wait_for('正在')
        wait_for('Bash · 完成')
        wait_for('任务完成')
        wait_for('const answer = 42;')
        offset = len(output)
        send('\x0f\x1b[5~')
        wait_for('checked', offset=offset)
        send('\x1b[6~\x0f')
        offset = len(output)
        send('cancel\r')
        wait_for('Bash · 执行中', offset=offset)
        send('draft\r')
        offset = len(output)
        send('\x03')
        wait_for('已取消', offset=offset)
        wait_for('draft', offset=offset)
        send('\x15error\r')
        wait_for('Simulated connection failure')
        offset = len(output)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 12, 40, 0, 0))
        os.kill(proc.pid, signal.SIGWINCH)
        wait_for('\x1b[11;', offset=offset)
        send('\x1b[5~\x1b[6~')
    # Keep a readable full frame as terminal-layout evidence.
    snapshot = output.decode('utf8', errors='replace').split('\x1b[H\x1b[2J')[-1]
    (artifact / 'completed-frame.txt').write_text(snapshot)
    offset = len(output)
    send('/exit\r')
    wait_for('\x1b[?1049l', timeout=5, offset=offset)
    proc.wait(timeout=5)
    while select.select([master], [], [], 0)[0]:
        output.extend(os.read(master, 65536))
    assert proc.returncode == 0
    assert b'\x1b[?1049l' in output
    assert termios.tcgetattr(slave) == original
    session_path = artifact / 'state/sessions/main.jsonl' if managed else artifact / 'session.jsonl'
    records = [json.loads(line) for line in session_path.read_text().splitlines()]
    ends = [entry['status'] for entry in records if entry['type'] == 'end']
    users = [entry['message']['content'] for entry in records if entry['type'] == 'message' and entry['message']['role'] == 'user']
    if live:
        assert ends == ['completed'], ends
        results = [json.loads(entry['message']['content']) for entry in records if entry['type'] == 'message' and entry['message']['role'] == 'tool']
        assert any(result.get('exit_code') == 0 and 'tui-live-ok' in result.get('output', '') for result in results)
    else:
        assert ends == ['completed', 'cancelled', 'failed'], ends
        assert users == ['你好🙂', 'cancel', 'error'], users
    report = {'status': 'passed', 'mode': 'default-npm-start' if automatic else 'managed-deepseek-live' if managed else 'deepseek-live' if live else 'local-pty',
              'realBash': True, 'terminalRestored': True, 'evidenceDirectory': str(artifact)}
    if not live:
        report.update(streamedText=True, busyDraftPreserved=True, cancelAndErrorRecovered=True, resized=True, markdownRendered=True, toolDetailsToggled=True)
    (artifact / 'report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report))
finally:
    if daemon is not None:
        daemon.terminate()
        daemon.wait(timeout=10)
    if automatic:
        subprocess.run(['node', '--experimental-strip-types', str(root / 'src/runtime/cli.ts'), 'stop'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    if proc.poll() is None:
        proc.kill()
        proc.wait()
    (artifact / 'terminal.raw').write_bytes(output)
    os.close(master)
    os.close(slave)
