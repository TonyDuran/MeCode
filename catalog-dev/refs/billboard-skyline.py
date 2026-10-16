import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_board(inp):
    d = ints(inp)
    n, h = d[0], d[1 : 1 + d[0]] + [0]
    st, best = [], 0
    for i, x in enumerate(h):
        start = i
        while st and st[-1][1] >= x:
            s, hh = st.pop()
            best = max(best, hh * (i - s))
            start = s
        st.append((start, x))
    return f"{best}\n"


sys.stdout.write(s_board(sys.stdin.read()))
