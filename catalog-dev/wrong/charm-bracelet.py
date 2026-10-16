import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_charm(inp):
    d = ints(inp)
    n, t, a = d[0], d[1], d[2 : 2 + d[0]]
    ways = Counter({0: 1})
    for x in a:
        nxt = Counter(ways)
        for s, c in ways.items():
            nxt[s + x] += c
        ways = nxt
    return f"{ways[t]}\n"


def w_charm(inp):  # treats charms with equal values as interchangeable
    d = ints(inp)
    n, t, a = d[0], d[1], d[2 : 2 + d[0]]
    seen = set()
    for m in range(1 << n):
        seen.add(tuple(sorted(a[i] for i in range(n) if m >> i & 1)) if sum(a[i] for i in range(n) if m >> i & 1) == t else None)
    seen.discard(None)
    return f"{len(seen)}\n"


sys.stdout.write(w_charm(sys.stdin.read()))
