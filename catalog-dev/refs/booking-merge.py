import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_merge(inp):
    d = ints(inp)
    iv = sorted((d[1 + 2 * i], d[2 + 2 * i]) for i in range(d[0]))
    out = []
    for s, e in iv:
        if out and s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return f"{len(out)}\n" + "\n".join(f"{s} {e}" for s, e in out) + "\n"


sys.stdout.write(s_merge(sys.stdin.read()))
