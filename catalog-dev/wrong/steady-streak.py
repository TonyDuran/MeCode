import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_streak(inp):
    d = ints(inp)
    n, a = d[0], d[1 : 1 + d[0]]
    best = cur = 1
    for i in range(1, n):
        cur = cur + 1 if a[i] == a[i - 1] else 1
        best = max(best, cur)
    return f"{best}\n"


def w_streak(inp):  # most frequent value, not necessarily consecutive
    d = ints(inp)
    return f"{max(Counter(d[1 : 1 + d[0]]).values())}\n"


sys.stdout.write(w_streak(sys.stdin.read()))
