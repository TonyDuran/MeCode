import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_hops(inp):
    d = ints(inp)
    n, h, hops = d[0], d[1], d[2 : 2 + d[1]]
    dp = [0] * (n + 1)
    dp[0] = 1
    for i in range(1, n + 1):
        dp[i] = sum(dp[i - x] for x in hops if x <= i) % 1000000007
    return f"{dp[n]}\n"


sys.stdout.write(s_hops(sys.stdin.read()))
