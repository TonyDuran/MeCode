import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_wild(inp):
    t = inp.split()
    n, q = int(t[0]), int(t[1])
    root = {}
    for w in t[2 : 2 + n]:
        node = root
        for ch in w:
            node = node.setdefault(ch, {})
        node["$"] = True

    def match(node, p, i):
        if i == len(p):
            return "$" in node
        if p[i] == ".":
            return any(match(c, p, i + 1) for k, c in node.items() if k != "$")
        return p[i] in node and match(node[p[i]], p, i + 1)

    return " ".join("YES" if match(root, p, 0) else "NO" for p in t[2 + n : 2 + n + q]) + "\n"


sys.stdout.write(s_wild(sys.stdin.read()))
