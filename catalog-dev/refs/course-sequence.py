import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_order(inp):
    d = ints(inp)
    n, m = d[0], d[1]
    adj, indeg = [[] for _ in range(n + 1)], [0] * (n + 1)
    for i in range(m):
        u, v = d[2 + 2 * i], d[3 + 2 * i]
        adj[u].append(v)
        indeg[v] += 1
    h = [v for v in range(1, n + 1) if indeg[v] == 0]
    heapq.heapify(h)
    out = []
    while h:
        u = heapq.heappop(h)
        out.append(u)
        for v in adj[u]:
            indeg[v] -= 1
            if indeg[v] == 0:
                heapq.heappush(h, v)
    return row(out) + "\n" if len(out) == n else "IMPOSSIBLE\n"


sys.stdout.write(s_order(sys.stdin.read()))
