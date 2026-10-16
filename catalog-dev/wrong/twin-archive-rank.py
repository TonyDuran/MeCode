import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_kth(inp):
    d = ints(inp)
    n, m, k = d[0], d[1], d[2]
    a, b = d[3 : 3 + n], d[3 + n : 3 + n + m]
    if n > m:
        a, b, n, m = b, a, m, n
    lo, hi = max(0, k - m), min(k, n)
    while lo < hi:  # take i items from a and k-i from b
        i = (lo + hi) // 2
        j = k - i
        if i < n and j > 0 and b[j - 1] > a[i]:
            lo = i + 1
        else:
            hi = i
    i, j = lo, k - lo
    cand = []
    if i > 0:
        cand.append(a[i - 1])
    if j > 0:
        cand.append(b[j - 1])
    return f"{max(cand)}\n"


def w_kth(inp):  # merges the lists but drops repeated values
    d = ints(inp)
    n, m, k = d[0], d[1], d[2]
    u = sorted(set(d[3 : 3 + n + m]))
    return f"{u[min(k, len(u)) - 1]}\n"


sys.stdout.write(w_kth(sys.stdin.read()))
