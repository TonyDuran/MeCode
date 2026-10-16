import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_dock(inp):
    d = ints(inp)
    n, t, a = d[0], d[1], d[2 : 2 + d[0]]
    i, j, r = 0, n - 1, 0
    while i < j:
        s = a[i] + a[j]
        if s < t:
            i += 1
        elif s > t:
            j -= 1
        else:
            r += 1
            x, y = a[i], a[j]
            while i < j and a[i] == x:
                i += 1
            while j > i and a[j] == y:
                j -= 1
    return f"{r}\n"


def w_dock(inp):  # counts index pairs (i < j), so repeated values inflate the answer; linear frequency accumulation, same output as the O(n^2) double loop
    d = ints(inp)
    n, t, a = d[0], d[1], d[2 : 2 + d[0]]
    seen = {}
    r = 0
    for x in a:
        r += seen.get(t - x, 0)
        seen[x] = seen.get(x, 0) + 1
    return f"{r}\n"


sys.stdout.write(w_dock(sys.stdin.read()))
