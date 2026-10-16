"""The 3 pre-existing original problems (ids, statements, examples and tests are retained from packs/core.json v1)."""
import sys, heapq, bisect, math, itertools, functools  # noqa: F401,E401
from collections import *  # noqa: F401,F403
from lib import add, ints, row, fmt  # noqa: F401


def s_beacon(inp):
    d = ints(inp)
    n, t = d[0], d[1]
    c = Counter()
    r = 0
    for x in d[2 : 2 + n]:
        r += c[t - x]
        c[x] += 1
    return f"{r}\n"


def b_beacon(inp):
    d = ints(inp)
    n, t = d[0], d[1]
    if n > 300:
        return None
    a = d[2 : 2 + n]
    return f"{sum(1 for i in range(n) for j in range(i + 1, n) if a[i] + a[j] == t)}\n"


def w_beacon(inp):  # counts value pairs, ignoring multiplicity
    d = ints(inp)
    n, t = d[0], d[1]
    s = set(d[2 : 2 + n])
    return f"{sum(1 for x in s if t - x in s and x <= t - x)}\n"


def g_beacon(rng, i):
    n = rng.randint(1, 8)
    return fmt(f"{n} {rng.randint(-3, 3)}", row([rng.randint(-3, 3) for _ in range(n)]))


def big_beacon(rng):
    return fmt("8000 50", row([rng.randint(0, 50) for _ in range(8000)]))


add(
    id="beacon-pairs",
    solve=s_beacon,
    brute=b_beacon,
    wrong=w_beacon,
    gen=g_beacon,
    big=big_beacon,
    known=[
        ("3 4\n2 2 2\n", "3"),
        ("2 1000000000\n500000000 500000000\n", "1"),
        ("2 0\n1000000000 -1000000000\n", "1"),
    ],
)


def s_bracket(inp):
    st = []
    pair = {")": "(", "]": "[", "}": "{"}
    for ch in inp.strip():
        if ch in "([{":
            st.append(ch)
        elif not st or st.pop() != pair[ch]:
            return "NO\n"
    return "NO\n" if st else "YES\n"


def b_bracket(inp):
    s = inp.strip()
    if len(s) > 200:
        return None
    while True:
        t = s.replace("()", "").replace("[]", "").replace("{}", "")
        if t == s:
            break
        s = t
    return "YES\n" if not s else "NO\n"


def w_bracket(inp):  # only compares totals of each kind
    s = inp.strip()
    return "YES\n" if all(s.count(a) == s.count(b) for a, b in ("()", "[]", "{}")) else "NO\n"


def g_bracket(rng, i):
    if i % 2:
        out = []

        def build(depth):
            for _ in range(rng.randint(0, 2)):
                if depth < 3 and len(out) < 12:
                    k = rng.choice("([{")
                    out.append(k)
                    build(depth + 1)
                    out.append({"(": ")", "[": "]", "{": "}"}[k])

        build(0)
        s = "".join(out) or "()"
        if i == 3 and len(s) > 1:  # corrupt one char of a balanced string
            p = rng.randrange(len(s))
            s = s[:p] + rng.choice(")]}([{") + s[p + 1 :]
        return s + "\n"
    return "".join(rng.choice("()[]{}") for _ in range(rng.randint(1, 10))) + "\n"


add(
    id="bracket-ledger",
    solve=s_bracket,
    brute=b_bracket,
    wrong=w_bracket,
    gen=g_bracket,
    big=lambda rng: "(" * 20000 + ")" * 20000 + "\n",
    known=[(")(\n", "NO"), ("((()))[]{}\n", "YES"), ("[(])\n", "NO"), ("{{}\n", "NO")],
)


def s_streak(inp):
    d = ints(inp)
    n, a = d[0], d[1 : 1 + d[0]]
    best = cur = 1
    for i in range(1, n):
        cur = cur + 1 if a[i] == a[i - 1] else 1
        best = max(best, cur)
    return f"{best}\n"


def b_streak(inp):
    d = ints(inp)
    n, a = d[0], d[1 : 1 + d[0]]
    if n > 400:
        return None
    return f"{max(j - i for i in range(n) for j in range(i + 1, n + 1) if len(set(a[i:j])) == 1)}\n"


def w_streak(inp):  # most frequent value, not necessarily consecutive
    d = ints(inp)
    return f"{max(Counter(d[1 : 1 + d[0]]).values())}\n"


def g_streak(rng, i):
    n = rng.randint(1, 10)
    return fmt(n, row([rng.randint(0, 2) for _ in range(n)]))


add(
    id="steady-streak",
    solve=s_streak,
    brute=b_streak,
    wrong=w_streak,
    gen=g_streak,
    big=lambda rng: fmt(9000, row([rng.randint(0, 1) for _ in range(9000)])),
    known=[("5\n1 2 1 2 1\n", "1"), ("3\n-5 -5 -5\n", "3"), ("2\n1000000000 -1000000000\n", "1"), ("6\n7 7 1 7 7 7\n", "3")],
)
