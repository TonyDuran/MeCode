import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_wall(inp):
    d = ints(inp)
    n, h = d[0], d[1 : 1 + d[0]]
    i, j, best = 0, n - 1, 0
    while i < j:
        best = max(best, min(h[i], h[j]) * (j - i))
        if h[i] < h[j]:
            i += 1
        else:
            j -= 1
    return f"{best}\n"


def w_wall(inp):  # only ever looks at the two outermost walls
    d = ints(inp)
    n, h = d[0], d[1 : 1 + d[0]]
    return f"{min(h[0], h[-1]) * (n - 1)}\n"


sys.stdout.write(w_wall(sys.stdin.read()))
