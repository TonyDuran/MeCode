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


def anc(n, L, R):
    par = [-1] * n
    for v in range(n):
        for c in (L[v], R[v]):
            if c != -1:
                par[c] = v
    return par


def s_lca(inp):
    n, V, L, R, rest = tree(inp)
    par = anc(n, L, R)
    dep = [0] * n
    order, st = [], [0]
    while st:
        v = st.pop()
        order.append(v)
        for c in (L[v], R[v]):
            if c != -1:
                dep[c] = dep[v] + 1
                st.append(c)
    q = rest[0]
    out = []
    for k in range(q):
        u, v = rest[1 + 2 * k], rest[2 + 2 * k]
        while u != v:
            if dep[u] >= dep[v]:
                u = par[u]
            else:
                v = par[v]
        out.append(u)
    return row(out) + "\n"


def w_lca(inp):  # always answers the root unless both queries are the same node
    n, V, L, R, rest = tree(inp)
    return row([rest[1 + 2 * k] if rest[1 + 2 * k] == rest[2 + 2 * k] else 0 for k in range(rest[0])]) + "\n"


sys.stdout.write(w_lca(sys.stdin.read()))
