"""Explicit, reproducible local checks. No benchmark or task knowledge."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def selected(source, names):
    source = Path(source).resolve()
    if not names or len(names) != len(set(names)):
        raise ValueError('Select distinct files explicitly')
    result = []
    for name in names:
        relative = Path(name)
        if relative.is_absolute() or '..' in relative.parts or not relative.parts:
            raise ValueError('Files must be relative paths without ..')
        path = source / relative
        if any(p.is_symlink() for p in [path, *path.parents] if p != source.parent):
            raise ValueError('Selected files must not use symlinks')
        if not path.is_file():
            raise ValueError('Missing file: ' + name)
        result.append((name, path))
    return result


def copy_files(files, destination):
    for name, source in files:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def init(root, source, names):
    files = selected(source, names)
    root.mkdir(parents=True, exist_ok=False)
    copy_files(files, root / 'inputs')
    write(root / 'inputs.json', {'source': str(Path(source).resolve()), 'files': names})


def execute(argv, cwd, timeout, log):
    if not isinstance(argv, list) or not argv or not all(isinstance(x, str) for x in argv):
        raise ValueError('Command must be a nonempty argv list')
    started = time.monotonic()
    with log.open('wb') as output:
        try:
            process = subprocess.Popen(argv, cwd=cwd, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        except OSError as error:
            return {'argv': argv, 'exit_code': None, 'error': str(error), 'timed_out': False}
        timed_out = False
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    return {'argv': argv, 'exit_code': process.returncode, 'timed_out': timed_out,
            'wall_seconds': time.monotonic() - started, 'log': str(log)}


def run(root, spec):
    inputs = selected(root / 'inputs', json.loads((root / 'inputs.json').read_text())['files'])
    candidates = selected(spec['candidate_source'], spec['candidates'])
    if set(n for n, _ in inputs) & set(n for n, _ in candidates):
        raise ValueError('Candidate files must not replace captured inputs')
    if not spec.get('hypothesis') or not spec.get('checks') or not spec.get('artifacts'):
        raise ValueError('Hypothesis, explicit checks and artifacts are required')
    timeout = spec.get('timeout_seconds')
    if timeout is not None and (not isinstance(timeout, (int, float)) or timeout <= 0):
        raise ValueError('timeout_seconds must be positive or null')
    for name in spec['artifacts']:
        if Path(name).is_absolute() or '..' in Path(name).parts:
            raise ValueError('Artifacts must be relative paths')
    attempts = root / 'attempts'
    attempts.mkdir(exist_ok=True)
    # Exclusive mkdir prevents concurrent runs from overwriting earlier evidence.
    number = 1
    while True:
        attempt = attempts / str(number)
        try:
            attempt.mkdir()
            break
        except FileExistsError:
            number += 1
    write(attempt / 'spec.json', spec)
    result = {'status': 'running', 'attempt': str(attempt), 'checks': []}
    write(attempt / 'result.json', result)
    try:
        copy_files(candidates, attempt / 'candidate')
        work = attempt / 'work'
        copy_files(inputs, work)
        copy_files(candidates, work)
        result['command'] = execute(spec['command'], work, timeout, attempt / 'command.log')
        # Record checks even after a target failure: matching output cannot erase that failure.
        for index, argv in enumerate(spec['checks']):
            result['checks'].append(execute(argv, work, timeout, attempt / f'check-{index}.log'))
        result['artifacts'] = {name: (work / name).is_file() and not (work / name).is_symlink() for name in spec['artifacts']}
        processes = [result['command'], *result['checks']]
        result['status'] = 'passed' if all(p['exit_code'] == 0 and not p['timed_out'] for p in processes) and all(result['artifacts'].values()) else 'failed'
    except Exception as error:
        result.update(status='error', error=str(error))
    write(attempt / 'result.json', result)
    return result


if __name__ == '__main__':
    try:
        operation, directory, *args = sys.argv[1:]
        root = Path(directory).resolve()
        if operation == 'init':
            init(root, args[0], args[1:])
            print(json.dumps({'status': 'captured', 'directory': str(root)}))
        elif operation == 'run' and len(args) == 1:
            result = run(root, json.loads(Path(args[0]).read_text()))
            print(json.dumps(result, ensure_ascii=False))
            sys.exit(0 if result['status'] == 'passed' else 1)
        else:
            raise ValueError('Usage: verify.py init DIR SOURCE FILE... | run DIR SPEC.json')
    except (ValueError, OSError, KeyError, IndexError) as error:
        print(json.dumps({'status': 'error', 'error': str(error)}))
        sys.exit(2)
