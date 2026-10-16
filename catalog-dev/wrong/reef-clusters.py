import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_island(inp):
    t = inp.split()
    R, C, g = int(t[0]), int(t[1]), t[2 : 2 + int(t[0])]
    seen = [[False] * C for _ in range(R)]
    cnt = best = 0
    for r in range(R):
        for c in range(C):
            if g[r][c] == "#" and not seen[r][c]:
                cnt += 1
                seen[r][c] = True
                st, area = [(r, c)], 0
                while st:
                    y, x = st.pop()
                    area += 1
                    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < R and 0 <= nx < C and g[ny][nx] == "#" and not seen[ny][nx]:
                            seen[ny][nx] = True
                            st.append((ny, nx))
                best = max(best, area)
    return f"{cnt} {best}\n"


def w_island(inp):  # lets diagonal neighbours connect
    t = inp.split()
    R, C, g = int(t[0]), int(t[1]), t[2 : 2 + int(t[0])]
    seen, cnt, best = set(), 0, 0
    for r in range(R):
        for c in range(C):
            if g[r][c] == "#" and (r, c) not in seen:
                cnt += 1
                seen.add((r, c))
                st, area = [(r, c)], 0
                while st:
                    y, x = st.pop()
                    area += 1
                    for dy in (-1, 0, 1):
                        for dx in (-1, 0, 1):
                            ny, nx = y + dy, x + dx
                            if 0 <= ny < R and 0 <= nx < C and g[ny][nx] == "#" and (ny, nx) not in seen:
                                seen.add((ny, nx))
                                st.append((ny, nx))
                best = max(best, area)
    return f"{cnt} {best}\n"


sys.stdout.write(w_island(sys.stdin.read()))
