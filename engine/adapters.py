"""Built-in language adapters. argv arrays only; no shell, no user-controlled filenames/flags."""

ADAPTERS = {
    "python": {"source": "main.py", "version": ["python3", "--version"], "compile": None, "run": ["python3", "-I", "{w}/main.py"]},
    "javascript": {"source": "main.js", "version": ["node", "--version"], "compile": None, "run": ["node", "{w}/main.js"]},
    "cpp": {"source": "main.cpp", "version": ["g++", "--version"],
            "compile": ["g++", "-std=c++17", "-O2", "-pipe", "{w}/main.cpp", "-o", "{w}/main"], "run": ["{w}/main"]},
    "c": {"source": "main.c", "version": ["gcc", "--version"],
          "compile": ["gcc", "-std=c17", "-O2", "-pipe", "{w}/main.c", "-o", "{w}/main"], "run": ["{w}/main"]},
}


def expand(argv, workdir):
    return [a.replace("{w}", workdir) for a in argv] if argv else None
