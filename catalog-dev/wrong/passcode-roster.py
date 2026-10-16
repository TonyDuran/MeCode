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


def w_pass(inp):  # forgets that equal letters make duplicate codes
    s = inp.strip()
    return "\n".join(sorted("".join(p) for p in permutations(s))) + "\n"


sys.stdout.write(w_pass(sys.stdin.read()))
