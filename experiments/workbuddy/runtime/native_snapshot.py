"""Copy native evaluation inputs inside a read-bounded OS sandbox.

The caller creates the destination outside the stage's writable tree. Directory
FDs and O_NOFOLLOW bind each copied object; no Agent-selected path is imported.
"""
import json, os, shutil, sqlite3, stat, sys, traceback
from pathlib import Path


class CandidateInputError(ValueError):
    """A candidate violates the existing snapshot content boundary."""


def copy_tree(source_fd, destination, relative=Path('.'), candidate=False):
    destination.mkdir()
    for name in os.listdir(source_fd):
        if name == '.git': continue
        info = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
        target = destination/name
        if stat.S_ISDIR(info.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=source_fd)
            try: copy_tree(child, target, relative/name, candidate)
            finally: os.close(child)
        elif stat.S_ISREG(info.st_mode):
            handle = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=source_fd)
            with os.fdopen(handle, 'rb') as reader, target.open('xb') as writer:
                if not stat.S_ISREG(os.fstat(reader.fileno()).st_mode): raise RuntimeError('Native input changed type')
                shutil.copyfileobj(reader, writer)
            target.chmod(info.st_mode & 0o777)
        elif stat.S_ISLNK(info.st_mode):
            link = os.readlink(name, dir_fd=source_fd)
            # Package .bin links are valid; absolute/escaping links cannot become host inputs.
            resolved = os.path.normpath(str(relative/link))
            if os.path.isabs(link) or resolved == '..' or resolved.startswith('../'):
                raise (CandidateInputError if candidate else RuntimeError)('Native source symlink escapes its version')
            target.symlink_to(link)
        else: raise (CandidateInputError if candidate else RuntimeError)('Unsupported native source file')


def validate_links(root, candidate=False):
    # This completed copy is outside Agent write access, so resolution is stable.
    boundary = root.resolve()
    for directory, folders, files in os.walk(root, followlinks=False):
        for name in folders + files:
            path = Path(directory)/name
            if path.is_symlink() and os.path.commonpath([boundary, path.resolve()]) != str(boundary):
                raise (CandidateInputError if candidate else RuntimeError)('Native source link resolves outside its copied version')


def snapshot(runtime, destination, source, candidate):
    root = Path(runtime); destination = Path(destination)
    # The OS sandbox is already active, including during SQLite/WAL opens.
    db = sqlite3.connect((root/'state.db').as_uri()+'?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    try:
        db.execute('BEGIN')
        current = db.execute('SELECT current_version FROM runtime_state WHERE id=1').fetchone()[0]
        source = source or current
        rows = []
        for identity in dict.fromkeys([source, candidate]):
            if not isinstance(identity,str) or Path(identity).name != identity or identity in ('.','..'): raise RuntimeError('Invalid version identifier')
            row = db.execute('SELECT id,parent_id,git_commit,runtime_path,reason FROM versions WHERE id=?',(identity,)).fetchone()
            if row is None: continue
            if row['runtime_path'] != str(root/'versions'/identity): raise (CandidateInputError if identity == candidate and identity != source else RuntimeError)('Native version path escapes registered directory')
            rows.append(dict(row))
        descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            versions = os.open('versions', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            try:
                (destination/'versions').mkdir()
                for row in rows:
                    child = os.open(row['id'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=versions)
                    try: copy_tree(child,destination/'versions'/row['id'], candidate=row['id'] == candidate and row['id'] != source)
                    finally: os.close(child)
                    validate_links(destination/'versions'/row['id'], candidate=row['id'] == candidate and row['id'] != source)
                    row['runtime_path'] = str(destination/'versions'/row['id'])
            finally: os.close(versions)
        finally: os.close(descriptor)
        (destination/'versions.json').write_text(json.dumps({'source':source,'current':current,'versions':rows}))
    finally: db.close()

if __name__ == '__main__':
    try:
        snapshot(*sys.argv[1:])
    except CandidateInputError as error:
        (Path(sys.argv[2])/'candidate-rejection.json').write_text(json.dumps({
            'kind': 'candidate_input_rejected', 'error': str(error), 'traceback': traceback.format_exc()}))
        traceback.print_exc()
        sys.exit(2)
