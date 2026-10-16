import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_lone(inp):
    d = ints(inp)
    a = d[1 : 1 + d[0]]
    res = 0
    for b in range(64):
        s = sum((x >> b) & 1 for x in a) % 3  # Python's >> on negatives is arithmetic: bit 63 is the sign bit
        res |= s << b
    return f"{res - (1 << 64) if res >> 63 else res}\n"


def w_lone(inp):  # XOR works for pairs, not for triples
    d = ints(inp)
    r = 0
    for x in d[1 : 1 + d[0]]:
        r ^= x
    return f"{r}\n"


sys.stdout.write(w_lone(sys.stdin.read()))
