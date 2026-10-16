import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_loop(inp):
    d = ints(inp)
    n = d[0]
    nxt = [d[2 + 2 * i] for i in range(n)]
    slow = fast = 0
    while True:
        if fast == -1 or nxt[fast] == -1:
            return "-1\n"
        slow, fast = nxt[slow], nxt[nxt[fast]]
        if slow == fast:
            break
    slow = 0
    while slow != fast:
        slow, fast = nxt[slow], nxt[fast]
    return f"{slow}\n"


def w_loop(inp):  # reports where the two runners first meet, not where the loop starts
    d = ints(inp)
    n = d[0]
    nxt = [d[2 + 2 * i] for i in range(n)]
    slow = fast = 0
    while True:
        if fast == -1 or nxt[fast] == -1:
            return "-1\n"
        slow, fast = nxt[slow], nxt[nxt[fast]]
        if slow == fast:
            return f"{slow}\n"


sys.stdout.write(w_loop(sys.stdin.read()))
