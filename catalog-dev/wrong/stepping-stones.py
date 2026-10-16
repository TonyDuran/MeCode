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


def w_stones(inp):  # only compares total jump power with the distance
    d = ints(inp)
    n, a = d[0], d[1 : 1 + d[0]]
    return "YES\n" if sum(a[:-1]) >= n - 1 else "NO\n"


sys.stdout.write(w_stones(sys.stdin.read()))
