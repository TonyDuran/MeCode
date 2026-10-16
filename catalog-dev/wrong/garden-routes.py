import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_routes(inp):
    t = inp.split()
    R, C, g = int(t[0]), int(t[1]), t[2 : 2 + int(t[0])]
    dp = [[0] * C for _ in range(R)]
    for r in range(R):
        for c in range(C):
            if g[r][c] == "#":
                continue
            if r == 0 and c == 0:
                dp[r][c] = 1
            else:
                dp[r][c] = ((dp[r - 1][c] if r else 0) + (dp[r][c - 1] if c else 0)) % 1000000007
    return f"{dp[R - 1][C - 1]}\n"


def w_routes(inp):  # ignores the blocked tiles
    t = inp.split()
    R, C = int(t[0]), int(t[1])
    return f"{math.comb(R + C - 2, R - 1) % 1000000007}\n"


sys.stdout.write(w_routes(sys.stdin.read()))
