"""Bounded execution wrapper used for an explicitly configured local OCR engine."""

import json
import os
from pathlib import Path
import resource
import sys


def main():
    request = json.loads(Path(sys.argv[1]).read_text())
    resource.setrlimit(resource.RLIMIT_FSIZE, (4_000_000, 4_000_000))
    resource.setrlimit(resource.RLIMIT_CPU, (120, 120))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    os.execv(request["command"][0], request["command"])


if __name__ == "__main__":
    main()
