import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_parcel(inp):
    d = ints(inp)
    n, days, w = d[0], d[1], d[2 : 2 + d[0]]

    def need(cap):
        c, cur = 1, 0
        for x in w:
            if cur + x > cap:
                c += 1
                cur = 0
            cur += x
        return c

    lo, hi = max(w), sum(w)
    while lo < hi:
        mid = (lo + hi) // 2
        if need(mid) <= days:
            hi = mid
        else:
            lo = mid + 1
    return f"{lo}\n"


sys.stdout.write(s_parcel(sys.stdin.read()))
