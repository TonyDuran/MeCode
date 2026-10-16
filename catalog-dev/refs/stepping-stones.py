import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_stones(inp):
    d = ints(inp)
    n, a = d[0], d[1 : 1 + d[0]]
    far = 0
    for i in range(n):
        if i > far:
            return "NO\n"
        far = max(far, i + a[i])
    return "YES\n"


sys.stdout.write(s_stones(sys.stdin.read()))
