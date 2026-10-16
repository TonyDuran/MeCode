import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_rival(inp):
    d = ints(inp)
    n, m = d[0], d[1]
    adj = [[] for _ in range(n + 1)]
    for i in range(m):
        u, v = d[2 + 2 * i], d[3 + 2 * i]
        adj[u].append(v)
        adj[v].append(u)
    col = [0] * (n + 1)
    for s in range(1, n + 1):
        if col[s]:
            continue
        col[s] = 1
        dq = deque([s])
        while dq:
            u = dq.popleft()
            for v in adj[u]:
                if not col[v]:
                    col[v] = 3 - col[u]
                    dq.append(v)
                elif col[v] == col[u]:
                    return "NO\n"
    return "YES\n"


sys.stdout.write(s_rival(sys.stdin.read()))
