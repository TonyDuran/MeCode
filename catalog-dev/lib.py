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


# ---- authoring-time domain validators (trusted DEV code; never shipped in a pack, never run by the app) ----
# Each returns a list of error strings for a stdin that violates the problem's published constraints/preconditions.
def charging_starts(inp):
    """All valid start stops of a charging-loop input, from signed prefix balances (exact, O(n))."""
    d = ints(inp)
    n, gain, cost = d[0], d[1 : 1 + d[0]], d[1 + d[0] : 1 + 2 * d[0]]
    pre, t = [0], 0  # pre[j] = balance after the first j legs
    for g, c in zip(gain, cost):
        t += g - c
        pre.append(t)
    if t < 0:
        return []
    # start s is valid iff every balance seen from s stays >= 0; wrapping past stop n-1 adds the total t (>= 0)
    suf = [float("inf")] * (n + 2)  # suf[j] = min(pre[j:]) ; head[j] = min(pre[1..j])
    for j in range(n, -1, -1):
        suf[j] = min(pre[j], suf[j + 1])
    head, h = [float("inf")], float("inf")
    for j in range(1, n + 1):
        h = min(h, pre[j])
        head.append(h)
    return [s for s in range(n) if suf[s + 1] >= pre[s] and (s == 0 or t + head[s] >= pre[s])]


def dom_charging(inp):
    d = ints(inp)
    n = d[0] if d else 0
    if not 1 <= n <= 20000 or len(d) != 1 + 2 * n:
        return [f"charging-loop shape: n={n}, {len(d)} integers"]
    if not all(0 <= x <= 1000000 for x in d[1:]):
        return ["charging-loop gain/cost outside 0..1000000"]
    st = charging_starts(inp)
    return [f"charging-loop start is not unique: valid starts {st}"] if len(st) > 1 else []


def dom_cars(inp):
    d = ints(inp)
    n, k = d[0], d[1]
    errs = []
    if not 1 <= n <= 20000 or len(d) != 2 + n:
        errs.append(f"coupled-cars shape: n={n}, {len(d)} integers")
    if not 1 <= k <= n + 1:
        errs.append(f"coupled-cars k={k} violates 1 <= k <= n+1 (n={n})")
    if not all(-(10**9) <= x <= 10**9 for x in d[2:]):
        errs.append("coupled-cars cargo outside +-1e9")
    return errs


def dom_route(inp):
    d = ints(inp)
    n, m = d[0], d[1]
    if not 1 <= n <= 2000 or not 0 <= m <= 6000 or len(d) != 2 + 3 * m:
        return [f"cheapest-route shape: n={n}, m={m}, {len(d)} integers"]
    errs = []
    for i in range(m):
        u, v, w = d[2 + 3 * i : 5 + 3 * i]
        if not (1 <= u <= n and 1 <= v <= n):
            errs.append(f"cheapest-route road {i + 1} endpoint outside 1..n: {u} {v}")
        if u == v:
            errs.append(f"cheapest-route road {i + 1} is a self-loop (u == v == {u}) violating u != v")
        if not 1 <= w <= 10**9:
            errs.append(f"cheapest-route road {i + 1} toll {w} outside 1..1e9")
    return errs[:3]


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
