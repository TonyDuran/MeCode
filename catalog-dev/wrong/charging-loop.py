import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_charge(inp):
    d = ints(inp)
    n, gain, cost = d[0], d[1 : 1 + d[0]], d[1 + d[0] : 1 + 2 * d[0]]
    if sum(gain) < sum(cost):
        return "-1\n"
    start = tank = 0
    for i in range(n):
        tank += gain[i] - cost[i]
        if tank < 0:
            start, tank = i + 1, 0
    return f"{start}\n"


def w_charge(inp):  # first station whose own charge covers its own leg
    d = ints(inp)
    n, gain, cost = d[0], d[1 : 1 + d[0]], d[1 + d[0] : 1 + 2 * d[0]]
    return f"{next((i for i in range(n) if gain[i] >= cost[i]), -1)}\n"


sys.stdout.write(w_charge(sys.stdin.read()))
