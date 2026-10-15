# Host-side cleanup. Membership comes from the kernel's inherited Seatbelt
# policy, not parent PIDs, process groups, environment variables or worker IPC.
import ctypes
import os
import signal
import sys
import time

proc = ctypes.CDLL('/usr/lib/libproc.dylib')
sandbox = ctypes.CDLL('/usr/lib/libsandbox.dylib')
sandbox.sandbox_check.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
sandbox.sandbox_check.restype = ctypes.c_int

verify = sys.argv[1] == '--verify'
check = sys.argv[1] == '--check'
paths = sys.argv[3:] if verify else sys.argv[2:] if check else sys.argv[1:]
allowed, denied = [os.fsencode(os.path.realpath(path)) for path in paths]

def owns(pid):
    def check(path):
        return sandbox.sandbox_check(pid, b'file-read-data', 1, ctypes.c_char_p(path))
    return pid > 1 and check(allowed) == 0 and check(denied) == 1

def members():
    size = proc.proc_listallpids(None, 0) + 256
    pids = (ctypes.c_int * size)()
    count = proc.proc_listallpids(pids, ctypes.sizeof(pids))
    if count <= 0 or count >= size:
        raise RuntimeError('Cannot enumerate sandbox processes')
    return {pid for pid in pids[:count] if owns(pid)}

def send(pids, sig):
    for pid in pids:
        # Recheck policy before every signal, including after a process exits.
        if owns(pid):
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass

if check:
    # Never use an ownership predicate that also matches the host itself.
    own = os.getpid()
    readable = all(sandbox.sandbox_check(own, b'file-read-data', 1, ctypes.c_char_p(path)) == 0 for path in (allowed, denied))
    sys.exit(0 if readable else 1)
if verify:
    sys.exit(0 if owns(int(sys.argv[2])) else 1)

# Freeze before killing so a detached child cannot keep spawning successors.
# Re-scan to include children forked while the first scan was in progress.
deadline = time.monotonic() + 3
while True:
    current = members()
    if not current:
        break
    send(current, signal.SIGSTOP)
    frozen = members()
    if frozen <= current:
        send(frozen, signal.SIGKILL)
    if time.monotonic() > deadline:
        raise RuntimeError('Sandbox processes did not terminate')
    time.sleep(0.01)
