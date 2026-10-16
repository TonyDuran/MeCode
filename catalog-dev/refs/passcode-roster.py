import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_pass(inp):
    s = inp.strip()
    cnt = Counter(s)
    keys = sorted(cnt)
    out, cur = [], []

    def go():
        if len(cur) == len(s):
            out.append("".join(cur))
            return
        for k in keys:
            if cnt[k]:
                cnt[k] -= 1
                cur.append(k)
                go()
                cur.pop()
                cnt[k] += 1

    go()
    return "\n".join(out) + "\n"


sys.stdout.write(s_pass(sys.stdin.read()))
