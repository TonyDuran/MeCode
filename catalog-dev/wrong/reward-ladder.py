import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_ladder(inp):
    d = ints(inp)
    r = d[1 : 1 + d[0]]
    n = d[0]
    c = [1] * n
    for i in range(1, n):
        if r[i] > r[i - 1]:
            c[i] = c[i - 1] + 1
    for i in range(n - 2, -1, -1):
        if r[i] > r[i + 1]:
            c[i] = max(c[i], c[i + 1] + 1)
    return f"{sum(c)}\n"


def w_ladder(inp):  # left-to-right pass only
    d = ints(inp)
    n, r = d[0], d[1 : 1 + d[0]]
    c = [1] * n
    for i in range(1, n):
        if r[i] > r[i - 1]:
            c[i] = c[i - 1] + 1
    return f"{sum(c)}\n"


sys.stdout.write(w_ladder(sys.stdin.read()))
