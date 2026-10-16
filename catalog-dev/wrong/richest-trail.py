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


def s_path(inp):
    n, V, L, R, _ = tree(inp)
    par = anc(n, L, R)
    order, st = [], [0]
    while st:
        v = st.pop()
        order.append(v)
        st += [c for c in (L[v], R[v]) if c != -1]
    down = [0] * n
    best = -(10**18)
    for v in reversed(order):
        gl = max(0, down[L[v]]) if L[v] != -1 else 0
        gr = max(0, down[R[v]]) if R[v] != -1 else 0
        down[v] = V[v] + max(gl, gr)
        best = max(best, V[v] + gl + gr)
    return f"{best}\n"


def w_path(inp):  # best downward path from the root only (never bends)
    n, V, L, R, _ = tree(inp)
    best = -(10**18)
    st = [(0, V[0])]
    while st:
        v, s = st.pop()
        best = max(best, s)
        for c in (L[v], R[v]):
            if c != -1:
                st.append((c, s + V[c]))
    return f"{best}\n"


sys.stdout.write(w_path(sys.stdin.read()))
