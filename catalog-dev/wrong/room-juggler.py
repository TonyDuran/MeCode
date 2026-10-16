import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_rooms(inp):
    d = ints(inp)
    ev = []
    for i in range(d[0]):
        ev.append((d[1 + 2 * i], 1))
        ev.append((d[2 + 2 * i], -1))
    ev.sort()  # at equal times the -1 (end) sorts before +1 (start): half-open intervals
    cur = best = 0
    for _, delta in ev:
        cur += delta
        best = max(best, cur)
    return f"{best}\n"


def w_rooms(inp):  # counts an ending meeting and a starting meeting at the same minute as overlapping
    d = ints(inp)
    ev = []
    for i in range(d[0]):
        ev.append((d[1 + 2 * i], 1))
        ev.append((d[2 + 2 * i], -1))
    ev.sort(key=lambda x: (x[0], -x[1]))
    cur = best = 0
    for _, delta in ev:
        cur += delta
        best = max(best, cur)
    return f"{best}\n"


sys.stdout.write(w_rooms(sys.stdin.read()))
