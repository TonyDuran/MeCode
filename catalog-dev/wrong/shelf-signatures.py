import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_shelf(inp):
    t = inp.split()
    n = int(t[0])
    c = Counter("".join(sorted(w)) for w in t[1 : 1 + n])
    return f"{len(c)} {max(c.values())}\n"


def w_shelf(inp):  # keys on the SET of letters, ignoring how many times each appears
    t = inp.split()
    n = int(t[0])
    c = Counter("".join(sorted(set(w))) for w in t[1 : 1 + n])
    return f"{len(c)} {max(c.values())}\n"


sys.stdout.write(w_shelf(sys.stdin.read()))
