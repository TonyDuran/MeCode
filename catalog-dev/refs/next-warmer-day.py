import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_warm(inp):
    d = ints(inp)
    n, a = d[0], d[1 : 1 + d[0]]
    res = [0] * n
    st = []
    for i, x in enumerate(a):
        while st and a[st[-1]] < x:
            j = st.pop()
            res[j] = i - j
        st.append(i)
    return row(res) + "\n"


sys.stdout.write(s_warm(sys.stdin.read()))
