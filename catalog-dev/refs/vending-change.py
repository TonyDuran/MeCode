import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_coins(inp):
    d = ints(inp)
    k, amt, coins = d[0], d[1], d[2 : 2 + d[0]]
    INF = 10**9
    dp = [0] + [INF] * amt
    for a in range(1, amt + 1):
        for c in coins:
            if c <= a and dp[a - c] + 1 < dp[a]:
                dp[a] = dp[a - c] + 1
    return f"{dp[amt] if dp[amt] < INF else -1}\n"


sys.stdout.write(s_coins(sys.stdin.read()))
