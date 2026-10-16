import sys, heapq, bisect, math, itertools, functools
from collections import *
from itertools import *

def ints(s):
    return list(map(int, s.split()))

def row(a):
    return " ".join(map(str, a))

def fmt(*lines):
    return "\n".join(str(x) for x in lines) + "\n"


def s_dir(inp):
    t = inp.split()
    n, q = int(t[0]), int(t[1])
    root = {}
    for w in t[2 : 2 + n]:
        node = root
        for ch in w:
            node = node.setdefault(ch, {})
            node["#"] = node.get("#", 0) + 1
    out = []
    for p in t[2 + n : 2 + n + q]:
        node = root
        for ch in p:
            node = node.get(ch)
            if node is None:
                break
        out.append(node["#"] if node else 0)
    return row(out) + "\n"


def w_dir(inp):  # counts distinct words only
    t = inp.split()
    n, q = int(t[0]), int(t[1])
    ws = set(t[2 : 2 + n])
    return row([sum(1 for w in ws if w.startswith(p)) for p in t[2 + n : 2 + n + q]]) + "\n"


sys.stdout.write(w_dir(sys.stdin.read()))
