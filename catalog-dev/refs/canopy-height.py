import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def tree(inp):
    d = ints(inp)
    n = d[0]
    L, R, V = [-1] * n, [-1] * n, [0] * n
    for i in range(n):
        V[i], L[i], R[i] = d[1 + 3 * i : 4 + 3 * i]
    return n, V, L, R, d[1 + 3 * n :]


def s_canopy(inp):
    n, V, L, R, _ = tree(inp)
    best, st = 0, [(0, 1)]
    while st:
        v, dep = st.pop()
        best = max(best, dep)
        for c in (L[v], R[v]):
            if c != -1:
                st.append((c, dep + 1))
    return f"{best}\n"


sys.stdout.write(s_canopy(sys.stdin.read()))
