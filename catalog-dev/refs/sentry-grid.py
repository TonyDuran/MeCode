import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_sentry(inp):
    t = inp.split()
    n, g = int(t[0]), t[1 : 1 + int(t[0])]
    full = (1 << n) - 1
    blocked = [sum(1 << c for c in range(n) if g[r][c] == "#") for r in range(n)]

    def go(r, cols, d1, d2):
        if r == n:
            return 1
        free = full & ~(cols | d1 | d2 | blocked[r])
        tot = 0
        while free:
            bit = free & -free
            free ^= bit
            tot += go(r + 1, cols | bit, ((d1 | bit) << 1) & full, (d2 | bit) >> 1)
        return tot

    return f"{go(0, 0, 0, 0)}\n"


sys.stdout.write(s_sentry(sys.stdin.read()))
