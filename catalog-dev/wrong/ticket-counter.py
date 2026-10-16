import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_ticket(inp):
    d = ints(inp)
    n, q = d[0], d[1]
    a, qs = d[2 : 2 + n], d[2 + n : 2 + n + q]
    return row([bisect.bisect_right(a, x) - bisect.bisect_left(a, x) for x in qs]) + "\n"


def w_ticket(inp):  # reports presence (0/1) instead of the number of copies
    d = ints(inp)
    n, q = d[0], d[1]
    a, qs = d[2 : 2 + n], d[2 + n : 2 + n + q]
    return row([1 if x in a else 0 for x in qs]) + "\n"


sys.stdout.write(w_ticket(sys.stdin.read()))
