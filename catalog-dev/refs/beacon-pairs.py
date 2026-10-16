import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_beacon(inp):
    d = ints(inp)
    n, t = d[0], d[1]
    c = Counter()
    r = 0
    for x in d[2 : 2 + n]:
        r += c[t - x]
        c[x] += 1
    return f"{r}\n"


sys.stdout.write(s_beacon(sys.stdin.read()))
