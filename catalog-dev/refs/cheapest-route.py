import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_route(inp):
    d = ints(inp)
    n, m = d[0], d[1]
    adj = [[] for _ in range(n + 1)]
    for i in range(m):
        u, v, w = d[2 + 3 * i : 5 + 3 * i]
        adj[u].append((v, w))
    INF = float("inf")
    dist = [INF] * (n + 1)
    dist[1] = 0
    h = [(0, 1)]
    while h:
        dd, u = heapq.heappop(h)
        if dd > dist[u]:
            continue
        for v, w in adj[u]:
            if dd + w < dist[v]:
                dist[v] = dd + w
                heapq.heappush(h, (dist[v], v))
    return f"{dist[n] if dist[n] < INF else -1}\n"


sys.stdout.write(s_route(sys.stdin.read()))
