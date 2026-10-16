import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_bracket(inp):
    st = []
    pair = {")": "(", "]": "[", "}": "{"}
    for ch in inp.strip():
        if ch in "([{":
            st.append(ch)
        elif not st or st.pop() != pair[ch]:
            return "NO\n"
    return "NO\n" if st else "YES\n"


def w_bracket(inp):  # only compares totals of each kind
    s = inp.strip()
    return "YES\n" if all(s.count(a) == s.count(b) for a, b in ("()", "[]", "{}")) else "NO\n"


sys.stdout.write(w_bracket(sys.stdin.read()))
