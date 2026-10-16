import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_spiral(inp):
    d = ints(inp)
    R, C = d[0], d[1]
    g = [d[2 + r * C : 2 + (r + 1) * C] for r in range(R)]
    top, bot, left, right = 0, R - 1, 0, C - 1
    out = []
    while top <= bot and left <= right:
        out += g[top][left : right + 1]
        out += [g[r][right] for r in range(top + 1, bot + 1)]
        if top < bot:
            out += g[bot][left:right][::-1]
        if left < right:
            out += [g[r][left] for r in range(bot - 1, top, -1)]
        top, bot, left, right = top + 1, bot - 1, left + 1, right - 1
    return row(out) + "\n"


def w_spiral(inp):  # four unguarded passes per ring: repeats cells on a single remaining row/column
    d = ints(inp)
    R, C = d[0], d[1]
    g = [d[2 + r * C : 2 + (r + 1) * C] for r in range(R)]
    top, bot, left, right = 0, R - 1, 0, C - 1
    out = []
    while top <= bot and left <= right:
        out += g[top][left : right + 1]
        out += [g[r][right] for r in range(top + 1, bot + 1)]
        out += g[bot][left:right][::-1]
        out += [g[r][left] for r in range(bot - 1, top, -1)]
        top, bot, left, right = top + 1, bot - 1, left + 1, right - 1
    return row(out) + "\n"


sys.stdout.write(w_spiral(sys.stdin.read()))
