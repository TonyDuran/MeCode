import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_flavor(inp):
    t = inp.split()
    k, s = int(t[0]), t[1]
    cnt = Counter()
    lo = best = 0
    for hi, ch in enumerate(s):
        cnt[ch] += 1
        while len(cnt) > k:
            cnt[s[lo]] -= 1
            if cnt[s[lo]] == 0:
                del cnt[s[lo]]
            lo += 1
        best = max(best, hi - lo + 1)
    return f"{best}\n"


def w_flavor(inp):  # demands EXACTLY k distinct letters
    t = inp.split()
    k, s = int(t[0]), t[1]
    best = 0
    for i in range(len(s)):
        for j in range(i + 1, len(s) + 1):
            if len(set(s[i:j])) == k:
                best = max(best, j - i)
    return f"{best}\n"


sys.stdout.write(w_flavor(sys.stdin.read()))
