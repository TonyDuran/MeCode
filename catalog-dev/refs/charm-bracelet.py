import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_charm(inp):
    d = ints(inp)
    n, t, a = d[0], d[1], d[2 : 2 + d[0]]
    ways = Counter({0: 1})
    for x in a:
        nxt = Counter(ways)
        for s, c in ways.items():
            nxt[s + x] += c
        ways = nxt
    return f"{ways[t]}\n"


sys.stdout.write(s_charm(sys.stdin.read()))
