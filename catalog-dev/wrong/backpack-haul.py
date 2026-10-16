import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_pack(inp):
    d = ints(inp)
    n, W = d[0], d[1]
    dp = [0] * (W + 1)
    for i in range(n):
        w, v = d[2 + 2 * i], d[3 + 2 * i]
        for c in range(W, w - 1, -1):
            dp[c] = max(dp[c], dp[c - w] + v)
    return f"{dp[W]}\n"


def w_pack(inp):  # greedy by value density
    d = ints(inp)
    n, W = d[0], d[1]
    it = sorted(((d[2 + 2 * i], d[3 + 2 * i]) for i in range(n)), key=lambda x: -x[1] / x[0])
    tot = 0
    for w, v in it:
        if w <= W:
            W -= w
            tot += v
    return f"{tot}\n"


sys.stdout.write(w_pack(sys.stdin.read()))
