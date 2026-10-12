"""Real default CLI/TUI and daemon against a local deterministic HTTP model."""
import fcntl
import json
import os
import pty
import select
import socket
import struct
import subprocess
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

repo = Path(__file__).resolve().parent.parent
artifact = repo / '.seeda' / f'session-pty-{int(time.time() * 1000)}'
artifact.mkdir(parents=True)
requests = []
class Model(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append(body)
        summary = body['messages'][0]['content'].startswith('Summarize task history')
        answer = 'Earlier goal retained.' if summary else '## 完成\n\n对话已保存。'
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        self.wfile.write(('data: ' + json.dumps({'choices': [{'delta': {'content': answer}, 'finish_reason': 'stop'}]}) + '\n\ndata: [DONE]\n\n').encode())
server = ThreadingHTTPServer(('127.0.0.1', 0), Model)
threading.Thread(target=server.serve_forever, daemon=True).start()
env = os.environ.copy()
env.update(SEEDA_LIBRARY=str(artifact / 'library'), SEEDA_HOME=str(artifact / 'state'), DEEPSEEK_API_KEY='local-test', DEEPSEEK_BASE_URL=f'http://127.0.0.1:{server.server_port}', SEEDA_SYSTEM_PROXY='0', NO_PROXY='127.0.0.1,localhost')
master, slave = pty.openpty()
original = termios.tcgetattr(slave)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 28, 110, 0, 0))
output = bytearray()
proc = None

def drain():
    while select.select([master], [], [], 0.02)[0]:
        output.extend(os.read(master, 65536))

def until(check, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        drain()
        try:
            if check():
                return
        except RuntimeError as error:
            if 'Session is changing' not in str(error):
                raise
        time.sleep(0.05)
    raise AssertionError('PTY condition timed out')

def rpc(operation, args=None):
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(3)
        connection.connect(str(artifact / 'state/control.sock'))
        connection.sendall((json.dumps({'id': 'smoke', 'operation': operation, 'args': args}) + '\n').encode())
        with connection.makefile('r') as stream:
            for line in stream:
                response = json.loads(line)
                if response.get('id') == 'smoke':
                    if response.get('error'):
                        raise RuntimeError(response['error'])
                    return response['result']

def launch():
    return subprocess.Popen(['npm', 'start'], cwd=repo, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)

def send(text):
    os.write(master, text.encode() + b'\r')

try:
    proc = launch()
    until(lambda: '选择起始种系'.encode() in output, 90)
    os.write(master, b'\r')
    until(lambda: '你好，我是 seeda'.encode() in output, 90)
    os.write(master, b'/')
    until(lambda: 'Tab 补全'.encode() in output and '/resume <'.encode() in output)
    os.write(master, b'\x1b[B\t')
    time.sleep(0.1)
    assert len(requests) == 0, 'Tab must not execute a model request'
    os.write(master, b'\r')
    time.sleep(0.2)
    assert rpc('session')['id'] == 'main'
    os.write(master, b'/res\r')
    time.sleep(0.1)
    assert len(requests) == 0, 'Selecting a parameter command must wait for its argument'
    os.write(master, b'main\r')
    time.sleep(0.5)
    send('first goal')
    until(lambda: len(requests) == 1 and len(rpc('history')) == 2)
    time.sleep(0.15)
    send('second goal')
    until(lambda: len(requests) == 2 and len(rpc('history')) == 4)
    time.sleep(0.15)
    send('/compact')
    until(lambda: len(requests) == 3 and '上下文已压缩'.encode() in output)
    rows = [json.loads(line) for line in (artifact / 'state/sessions/main.jsonl').read_text().splitlines()]
    assert len([row for row in rows if row['type'] == 'message']) == 4
    assert any(row['type'] == 'compact' for row in rows)
    time.sleep(0.15)
    send('/new')
    until(lambda: rpc('session')['id'] != 'main')
    current = rpc('session')['id']
    assert rpc('history') == []
    time.sleep(0.2)
    send('/sessions')
    until(lambda: current.encode() in output and 'first goal'.encode() in output)
    time.sleep(0.2)
    send('/resume main')
    until(lambda: rpc('session')['id'] == 'main')
    assert len(rpc('history')) == 4
    time.sleep(0.2)
    send('/exit')
    proc.wait(timeout=5)
    assert termios.tcgetattr(slave) == original
    boundary = len(output)
    proc = launch()
    until(lambda: 'second goal'.encode() in output[boundary:] and rpc('session')['id'] == 'main')
    time.sleep(0.5)
    send('/exit')
    proc.wait(timeout=5)
    assert len(requests) == 3, 'Control commands must not become model prompts'
    assert not requests[2].get('tools'), 'Compaction must not execute tools'
    report = {'status': 'passed', 'mode': 'default managed npm start, real PTY, local HTTP model', 'model_requests': len(requests), 'current': 'main', 'new_session': current, 'checks': ['two persisted turns', 'manual summary', 'original history retained', 'new empty session', 'session listing', 'resume', 'frontend reopen', 'termios restored', 'commands excluded from model', 'slash preview', 'arrow navigation and Tab', 'Enter waits for resume argument']}
    (artifact / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(artifact / 'report.json')
finally:
    (artifact / 'terminal.bin').write_bytes(output)
    if proc and proc.poll() is None:
        proc.terminate()
        proc.wait(timeout=5)
    subprocess.run(['node', '--experimental-strip-types', str(repo / 'src/runtime/cli.ts'), 'stop'], cwd=repo, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    server.shutdown()
    os.close(master)
    os.close(slave)
