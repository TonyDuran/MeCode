import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_lantern_fest(inp):
    d = ints(inp)
    a = d[1 : 1 + d[0]]
    take = skip = 0
    for x in a:
        take, skip = skip + x, max(skip, take)
    return f"{max(take, skip, 0)}\n"


sys.stdout.write(s_lantern_fest(sys.stdin.read()))
