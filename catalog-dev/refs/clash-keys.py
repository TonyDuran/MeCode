import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_xor(inp):
    d = ints(inp)
    a = d[1 : 1 + d[0]]
    best = 0
    for b in range(30, -1, -1):
        cand = best | (1 << b)
        pre = {x >> b for x in a}
        if any((p ^ (cand >> b)) in pre for p in pre):
            best = cand
    return f"{best}\n"


sys.stdout.write(s_xor(sys.stdin.read()))
