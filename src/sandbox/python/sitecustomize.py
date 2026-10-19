"""Map Python's semaphore names into the sandbox's allocated namespace."""
import os
import re

prefix = os.environ.get('SEEDA_SEMAPHORE_PREFIX', '')
if re.fullmatch(r'/sd-[0-9a-f]{16}', prefix):
    import multiprocessing.process
    multiprocessing.process.current_process()._config['semprefix'] = prefix
