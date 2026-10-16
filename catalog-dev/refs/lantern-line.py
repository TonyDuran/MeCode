import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_line(inp):
    d = ints(inp)
    n = d[0]
    pts = [(d[1 + 2 * i], d[2 + 2 * i]) for i in range(n)]
    best = 1
    for i in range(n):
        cnt = Counter()
        for j in range(i + 1, n):
            dx, dy = pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]
            g = math.gcd(dx, dy)
            dx, dy = dx // g, dy // g
            if dx < 0 or (dx == 0 and dy < 0):
                dx, dy = -dx, -dy
            cnt[(dx, dy)] += 1
        if cnt:
            best = max(best, max(cnt.values()) + 1)
    return f"{best}\n"


sys.stdout.write(s_line(sys.stdin.read()))
