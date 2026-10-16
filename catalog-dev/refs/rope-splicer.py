import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_rope(inp):
    d = ints(inp)
    h = d[1 : 1 + d[0]]
    heapq.heapify(h)
    cost = 0
    while len(h) > 1:
        x, y = heapq.heappop(h), heapq.heappop(h)
        cost += x + y
        heapq.heappush(h, x + y)
    return f"{cost}\n"


sys.stdout.write(s_rope(sys.stdin.read()))
