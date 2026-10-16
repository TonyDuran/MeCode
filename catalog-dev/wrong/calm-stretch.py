import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_calm(inp):
    d = ints(inp)
    n, lim, a = d[0], d[1], d[2 : 2 + d[0]]
    mx, mn = deque(), deque()
    lo = best = 0
    for hi in range(n):
        while mx and a[mx[-1]] <= a[hi]:
            mx.pop()
        mx.append(hi)
        while mn and a[mn[-1]] >= a[hi]:
            mn.pop()
        mn.append(hi)
        while a[mx[0]] - a[mn[0]] > lim:
            lo += 1
            if mx[0] < lo:
                mx.popleft()
            if mn[0] < lo:
                mn.popleft()
        best = max(best, hi - lo + 1)
    return f"{best}\n"


def w_calm(inp):  # only compares neighbours
    d = ints(inp)
    n, lim, a = d[0], d[1], d[2 : 2 + d[0]]
    best = cur = 1
    for i in range(1, n):
        cur = cur + 1 if abs(a[i] - a[i - 1]) <= lim else 1
        best = max(best, cur)
    return f"{best}\n"


sys.stdout.write(w_calm(sys.stdin.read()))
