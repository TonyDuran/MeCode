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


def w_ledger(inp):  # two-pointer window: only valid if every entry were positive
    d = ints(inp)
    n, k = d[0], d[1]
    a = d[2 : 2 + n]
    r = lo = s = 0
    for hi in range(n):
        s += a[hi]
        while s > k and lo <= hi:
            s -= a[lo]
            lo += 1
        if s == k:
            r += 1
    return f"{r}\n"


sys.stdout.write(w_ledger(sys.stdin.read()))
