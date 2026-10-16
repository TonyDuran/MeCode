import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_median(inp):
    d = ints(inp)
    lo, hi, out = [], [], []  # lo: max-heap (negated), hi: min-heap; |lo| == |hi| or |hi| + 1
    for x in d[1 : 1 + d[0]]:
        if lo and x > -lo[0]:
            heapq.heappush(hi, x)
        else:
            heapq.heappush(lo, -x)
        if len(lo) > len(hi) + 1:
            heapq.heappush(hi, -heapq.heappop(lo))
        elif len(hi) > len(lo):
            heapq.heappush(lo, -heapq.heappop(hi))
        out.append(-lo[0])
    return row(out) + "\n"


def w_median(inp):  # reports the upper middle value when the count is even
    d = ints(inp)
    a = d[1 : 1 + d[0]]
    return row([sorted(a[: i + 1])[(i + 1) // 2] for i in range(len(a))]) + "\n"


sys.stdout.write(w_median(sys.stdin.read()))
