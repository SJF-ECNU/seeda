"""Only exec into the caller-owned task container; never expose the real Docker socket."""
import http.client,json,re,socket,threading,time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path

class UnixHTTP(http.client.HTTPConnection):
    def __init__(self,path):super().__init__('localhost',timeout=900);self.path=path
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(self.timeout);self.sock.connect(self.path)

class DockerScope:
    def __init__(self,socket_path,container,log_path,user="dev"):
        self.user=user;self.socket_path=socket_path;self.container=container;self.ids=set();self.lock=threading.Lock();self.log_path=Path(log_path)
        self.task_ids=set();self.proof={'started':0,'failure':None};self.proof_path=self.log_path.with_name('command-execution.json')
    def record(self,*,started=False,failure=None):
        with self.lock:
            if started:self.proof['started']+=1
            if failure and not self.proof['failure']:self.proof['failure']=failure
            self.proof_path.parent.mkdir(parents=True,exist_ok=True)
            temporary=self.proof_path.with_suffix('.tmp');temporary.write_text(json.dumps(self.proof));temporary.replace(self.proof_path)
    def start(self):
        self.record()
        scope=self
        class Handler(BaseHTTPRequestHandler):
            protocol_version='HTTP/1.1'
            def log_message(self,*args):pass
            def do_GET(self):self.forward()
            def do_HEAD(self):self.forward()
            def do_POST(self):self.forward()
            def do_DELETE(self):self.reject()
            def reject(self):
                self.send_response(403);self.send_header('Content-Length','0');self.end_headers()
            def forward(self):
                path=re.sub(r'^/v[0-9.]+','',self.path.split('?')[0]);body=b'';allowed=False;create=False;task=False
                if path in ['/_ping','/version'] and self.command in ['GET','HEAD']:allowed=True
                if path==f'/containers/{scope.container}/json' and self.command=='GET':allowed=True
                if path==f'/containers/{scope.container}/exec' and self.command=='POST':
                    n=int(self.headers.get('Content-Length','0'))
                    if n>1024*1024:return self.reject()
                    body=self.rfile.read(n)
                    try:data=json.loads(body)
                    except ValueError:return self.reject()
                    allowed=not data.get('Privileged') and not data.get('AttachStdin');create=allowed
                    if allowed:
                        data['User']=scope.user
                        body=json.dumps(data).encode()
                    task=any(str(value).startswith('SEEDA_COMMAND_ID=') for value in (data.get('Env') or []))
                m=re.fullmatch(r'/exec/([0-9a-f]+)/(?P<op>start|json|resize)',path)
                if m:
                    with scope.lock:known=m[1] in scope.ids
                    with scope.lock:task=m[1] in scope.task_ids
                    allowed=known and ((m['op']=='json' and self.command=='GET') or (m['op']=='start' and self.command=='POST'))
                    if allowed:
                        n=int(self.headers.get('Content-Length','0'))
                        if n>65536:return self.reject()
                        body=self.rfile.read(n)
                with scope.lock:
                    scope.log_path.parent.mkdir(parents=True,exist_ok=True)
                    with scope.log_path.open('a') as f:f.write(json.dumps({'at':time.time(),'method':self.command,'path':path,'allowed':allowed})+'\n')
                if not allowed:return self.reject()
                conn=UnixHTTP(scope.socket_path)
                try:
                    headers={'Content-Type':'application/json'}
                    if 'upgrade' in self.headers.get('Connection','').lower():headers.update(Connection='Upgrade',Upgrade='tcp')
                    conn.request(self.command,self.path,body=body or None,headers=headers);res=conn.getresponse()
                    if task and res.status>=400:scope.record(failure=f'Docker {path} returned HTTP {res.status}')
                    if create:
                        output=res.read()
                        if res.status==201:
                            with scope.lock:
                                exec_id=json.loads(output)['Id'];scope.ids.add(exec_id)
                                if task:scope.task_ids.add(exec_id)
                        self.send_response(res.status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(output)));self.end_headers();self.wfile.write(output);return
                    self.send_response(res.status)
                    self.send_header('Content-Type',res.getheader('Content-Type','application/json'))
                    if res.getheader('API-Version'):self.send_header('API-Version',res.getheader('API-Version'))
                    if task and m and m['op']=='start' and res.status in (101,200):scope.record(started=True)
                    if res.status==101:self.send_header('Connection','Upgrade');self.send_header('Upgrade','tcp')
                    else:self.send_header('Connection','close')
                    self.end_headers()
                    if self.command!='HEAD':
                        reader=res.fp if res.status==101 else res
                        while True:
                            chunk=reader.read1(65536)
                            if not chunk:break
                            self.wfile.write(chunk);self.wfile.flush()
                    self.close_connection=True
                except (OSError,http.client.HTTPException) as error:
                    if task:scope.record(failure=f'Docker transport failed: {type(error).__name__}')
                    self.close_connection=True
                finally:conn.close()
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler);self.server.daemon_threads=True
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.url=f'tcp://127.0.0.1:{self.server.server_port}';return self
    def close(self):self.server.shutdown();self.server.server_close();self.thread.join(timeout=2)
