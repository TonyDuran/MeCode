import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_ledger(inp):
    d = ints(inp)
    n, k = d[0], d[1]
    seen = Counter({0: 1})
    p = r = 0
    for x in d[2 : 2 + n]:
        p += x
        r += seen[p - k]
        seen[p] += 1
    return f"{r}\n"


sys.stdout.write(s_ledger(sys.stdin.read()))
