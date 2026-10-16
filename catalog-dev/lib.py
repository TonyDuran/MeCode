"""MeCode catalog development library (DEVELOPMENT ASSET, never shipped to learners, never executed by the app).

Each problem module calls add(...) with metadata, a trusted Python reference `solve`, an optional independent
`brute` oracle, a deliberately wrong `wrong` baseline, a seeded small-case generator `gen`, hand-written known answers
`ex` (visible examples, with explanations) and `known` (hand-computed edge cases), and an optional `big` generator.
Outputs are compared with the app's `tokens` comparator, so every answer is a canonical integer/word token sequence.
"""

import random

REG = []
PATTERNS = [
    # (slug, label, required count) -- T01 distribution: 12 x 3 + 6 x 2 = 48 problems / 18 patterns
    ("arrays-hashing", "Arrays & Hashing", 3),
    ("two-pointers", "Two Pointers", 3),
    ("sliding-window", "Sliding Window", 3),
    ("stack", "Stack", 3),
    ("binary-search", "Binary Search", 3),
    ("trees", "Trees", 3),
    ("heap", "Heap / Priority Queue", 3),
    ("backtracking", "Backtracking", 3),
    ("graphs", "Graphs (BFS/DFS)", 3),
    ("dp-1d", "1-D Dynamic Programming", 3),
    ("dp-2d", "2-D Dynamic Programming", 3),
    ("greedy", "Greedy", 3),
    ("linked-lists", "Linked Lists", 2),
    ("tries", "Tries", 2),
    ("advanced-graphs", "Advanced Graphs", 2),
    ("intervals", "Intervals", 2),
    ("math-geometry", "Math & Geometry", 2),
    ("bit-manipulation", "Bit Manipulation", 2),
]
PATTERN_SLUGS = [p[0] for p in PATTERNS]
SEEDED_CASES = 4  # seeded small generated checks stored per problem
EXTRA_DIFFERENTIAL = 150  # additional seeded cases compared solve-vs-brute at verification time (not stored)


def add(**kw):
    REG.append(kw)


def ints(s):
    return list(map(int, s.split()))


def row(a):
    return " ".join(map(str, a))


def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def rng_for(pid, tag):
    # str seeds are hashed with SHA-512 by random.Random, so this is stable across runs and platforms.
    return random.Random(f"mecode-catalog:{pid}:{tag}")


# ---- honest TODO starter skeletons: read the input, print a placeholder, never a working solution ----
def starters(inf):
    note = " ".join(inf.split())
    py = (
        "import sys\n\n"
        "def main():\n"
        "    data = sys.stdin.read().split()\n"
        f"    # Input: {note}\n"
        "    # TODO: parse `data`, solve the problem, print the answer.\n"
        "    print(0)  # placeholder so the program runs\n\n"
        "main()\n"
    )
    js = (
        "const data = require('fs').readFileSync(0, 'utf8').split(/\\s+/).filter(Boolean);\n"
        f"// Input: {note}\n"
        "// TODO: parse `data`, solve the problem, print the answer.\n"
        "console.log(0); // placeholder so the program runs\n"
    )
    cpp = (
        "#include <bits/stdc++.h>\n"
        "using namespace std;\n\n"
        "int main() {\n"
        "    ios::sync_with_stdio(false);\n"
        "    cin.tie(nullptr);\n"
        "    vector<string> data;\n"
        "    string tok;\n"
        "    while (cin >> tok) data.push_back(tok);\n"
        f"    // Input: {note}\n"
        "    // TODO: parse `data`, solve the problem, print the answer.\n"
        '    cout << 0 << "\\n";  // placeholder so the program runs\n'
        "    return 0;\n"
        "}\n"
    )
    c = (
        "#include <stdio.h>\n"
        "#include <stdlib.h>\n"
        "#include <string.h>\n\n"
        "static char buf[1 << 17];\n\n"
        "int main(void) {\n"
        "    size_t len = fread(buf, 1, sizeof buf - 1, stdin);\n"
        "    buf[len] = 0;\n"
        f"    /* Input: {note.replace('*/', '* /')} */\n"
        "    /* TODO: parse buf (strtok / strtoll), solve the problem, print the answer. */\n"
        '    printf("0\\n");  /* placeholder so the program runs */\n'
        "    return 0;\n"
        "}\n"
    )
    return {"python": py, "javascript": js, "cpp": cpp, "c": c}
