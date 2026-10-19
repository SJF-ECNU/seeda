import sys,tempfile,unittest,io,json,socket,urllib.error
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent/'runtime'))
from meter import Meter
class Response:
 status=200;headers={'Content-Type':'text/event-stream'}
 def __init__(self,error=None):self.error=error;self.n=0
 def read1(self,n):
  if self.error:raise self.error
  self.n+=1
  return b'data: {"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n' if self.n==1 else b''
 def close(self):pass
class Handler:
 path='/key/v1/chat/completions';headers={}
 def __init__(self,write_error=False):
  b=json.dumps({'model':'test','messages':[],'stream':True}).encode();self.headers={'Content-Length':str(len(b))};self.rfile=io.BytesIO(b);self.wfile=self
  self.write_error=write_error;self.connection=socket.socket()
 def send_response(self,*a):pass
 def send_header(self,*a):pass
 def end_headers(self):pass
 def write(self,b):
  if self.write_error:raise BrokenPipeError(32,'SECRET MUST NOT BE LOGGED')
 def flush(self):pass
class Tests(unittest.TestCase):
 def case(self,phase,error,expected):
  with tempfile.TemporaryDirectory() as td:
   m=Meter('http://upstream.invalid','SECRET','test',log_path=Path(td)/'attempts.jsonl')
   m.start();m.register('x',None,None,'work');m.tokens['key']='x'
   class Opener:
    def open(self,*a,**k):
     if phase=='upstream_connect':raise error
     return Response(error if phase=='upstream_read' else None)
   m.opener=Opener();h=Handler(phase=='downstream_write')
   m._handle(h);h.connection.close();record=m.records[-1]
   self.assertEqual(record['status'],expected);self.assertEqual(record['transport_error']['operation'],phase)
   self.assertTrue(record['transport_error']['exception_chain']);self.assertEqual(m.stop_reason,expected)
   m.log.flush();self.assertNotIn('SECRET',Path(td,'attempts.jsonl').read_text());m.close()
 def test_connect_reset(self):self.case('upstream_connect',ConnectionResetError(54,'SECRET'),'upstream_connection_error')
 def test_read_reset(self):self.case('upstream_read',ConnectionResetError(54,'SECRET'),'upstream_connection_error')
 def test_read_timeout(self):self.case('upstream_read',TimeoutError('SECRET'),'upstream_timeout')
 def test_wrapped_timeout(self):self.case('upstream_connect',urllib.error.URLError(TimeoutError('SECRET')),'upstream_timeout')
 def test_http_error(self):self.case('upstream_connect',urllib.error.HTTPError('http://SECRET',503,'SECRET',{},io.BytesIO(b'SECRET')),'upstream_http_error')
 def test_client_disconnect(self):self.case('downstream_write',None,'client_disconnected')
if __name__=='__main__':unittest.main()
