import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_feeds(inp):
    d = ints(inp)
    k, pos, lists = d[0], 1, []
    for _ in range(k):
        m = d[pos]
        lists.append(d[pos + 1 : pos + 1 + m])
        pos += 1 + m
    h = [(l[0], i, 0) for i, l in enumerate(lists) if l]
    heapq.heapify(h)
    out = []
    while h:
        v, i, j = heapq.heappop(h)
        out.append(v)
        if j + 1 < len(lists[i]):
            heapq.heappush(h, (lists[i][j + 1], i, j + 1))
    return row(out) + "\n"


sys.stdout.write(s_feeds(sys.stdin.read()))
