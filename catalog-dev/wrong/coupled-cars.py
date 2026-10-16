import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_cars(inp):
    d = ints(inp)
    n, k = d[0], d[1]
    val = d[2 : 2 + n]
    nxt = [i + 1 for i in range(n)]
    nxt[-1] = -1  # singly linked: node i -> node i+1
    head, prev_tail = 0, -1
    cur = 0
    new_head = None
    while cur != -1:
        # find the k-th node from cur; skip the group if fewer than k nodes remain
        probe, cnt = cur, 0
        while probe != -1 and cnt < k:
            probe, cnt = nxt[probe], cnt + 1
        if cnt < k:
            if prev_tail != -1:
                nxt[prev_tail] = cur
            break
        # reverse k nodes starting at cur; `probe` is the node after the group
        prev, node = probe, cur
        for _ in range(k):
            nxt[node], prev, node = prev, node, nxt[node]
        if new_head is None:
            new_head = prev
        else:
            nxt[prev_tail] = prev
        prev_tail = cur
        cur = probe
    out, p = [], new_head if new_head is not None else 0
    while p != -1:
        out.append(val[p])
        p = nxt[p]
    return row(out) + "\n"


def w_cars(inp):  # also reverses the short final group
    d = ints(inp)
    n, k, a = d[0], d[1], d[2 : 2 + d[0]]
    out = []
    for i in range(0, n, k):
        out += a[i : i + k][::-1]
    return row(out) + "\n"


sys.stdout.write(w_cars(sys.stdin.read()))
