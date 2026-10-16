import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_mold(inp):
    t = inp.split()
    R, C, g = int(t[0]), int(t[1]), t[2 : 2 + int(t[0])]
    dist = {}
    dq = deque()
    for r in range(R):
        for c in range(C):
            if g[r][c] == "M":
                dist[(r, c)] = 0
                dq.append((r, c))
    while dq:
        y, x = dq.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < R and 0 <= nx < C and g[ny][nx] in ".B" and (ny, nx) not in dist:
                dist[(ny, nx)] = dist[(y, x)] + 1
                dq.append((ny, nx))
    best = 0
    for r in range(R):
        for c in range(C):
            if g[r][c] == "B":
                if (r, c) not in dist:
                    return "-1\n"
                best = max(best, dist[(r, c)])
    return f"{best}\n"


sys.stdout.write(s_mold(sys.stdin.read()))
