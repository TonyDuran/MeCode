"""Batch 2: binary-search, trees, heap, backtracking (new problems)."""
import sys, heapq, bisect, math, itertools, functools  # noqa: F401,E401
from collections import *  # noqa: F401,F403
from itertools import permutations
from lib import add, ints, row, fmt  # noqa: F401


# ---------------------------------------------------------------- binary-search
def s_ticket(inp):
    d = ints(inp)
    n, q = d[0], d[1]
    a, qs = d[2 : 2 + n], d[2 + n : 2 + n + q]
    return row([bisect.bisect_right(a, x) - bisect.bisect_left(a, x) for x in qs]) + "\n"


def b_ticket(inp):
    d = ints(inp)
    n, q = d[0], d[1]
    a, qs = d[2 : 2 + n], d[2 + n : 2 + n + q]
    if n > 200:
        return None
    return row([a.count(x) for x in qs]) + "\n"


def w_ticket(inp):  # reports presence (0/1) instead of the number of copies
    d = ints(inp)
    n, q = d[0], d[1]
    a, qs = d[2 : 2 + n], d[2 + n : 2 + n + q]
    return row([1 if x in a else 0 for x in qs]) + "\n"


def g_ticket(rng, i):
    n, q = rng.randint(1, 8), rng.randint(1, 5)
    a = sorted(rng.randint(0, 5) for _ in range(n))
    return fmt(f"{n} {q}", row(a), row([rng.randint(-1, 6) for _ in range(q)]))


add(
    id="ticket-counter",
    title="Ticket Counter",
    diff="easy",
    pat="binary-search",
    st="A theatre keeps its n sold ticket numbers in a sorted list; a number can appear several times because group tickets share a code. For each of q queries, report how many sold tickets carry exactly that number.",
    inf="Line 1: n and q. Line 2: n integers in non-decreasing order. Line 3: q query integers.",
    outf="q integers separated by single spaces on one line: the number of copies of each query value.",
    cons=["1 <= n <= 8000", "1 <= q <= 2000", "-1000000000 <= value <= 1000000000", "The sold list is sorted in non-decreasing order"],
    solve=s_ticket,
    brute=b_ticket,
    wrong=w_ticket,
    gen=g_ticket,
    big=lambda rng: fmt("8000 2000", row(sorted(rng.randint(0, 3000) for _ in range(8000))), row([rng.randint(-5, 3005) for _ in range(2000)])),
    ex=[
        ("6 3\n1 2 2 2 5 9\n2 5 7\n", "3 1 0", "Value 2 appears three times, 5 once and 7 never."),
        ("1 2\n4\n4 3\n", "1 0", "A single sold ticket matches only 4."),
    ],
    known=[("3 1\n7 7 7\n7\n", "3"), ("4 4\n-5 -5 0 10\n-5 0 10 11\n", "2 1 1 0"), ("2 2\n1000000000 1000000000\n1000000000 -1000000000\n", "2 0"), ("5 1\n1 2 3 4 5\n0\n", "0")],
)


def s_parcel(inp):
    d = ints(inp)
    n, days, w = d[0], d[1], d[2 : 2 + d[0]]

    def need(cap):
        c, cur = 1, 0
        for x in w:
            if cur + x > cap:
                c += 1
                cur = 0
            cur += x
        return c

    lo, hi = max(w), sum(w)
    while lo < hi:
        mid = (lo + hi) // 2
        if need(mid) <= days:
            hi = mid
        else:
            lo = mid + 1
    return f"{lo}\n"


def b_parcel(inp):
    d = ints(inp)
    n, days, w = d[0], d[1], d[2 : 2 + d[0]]
    if sum(w) > 3000:
        return None
    for cap in range(max(w), sum(w) + 1):
        c, cur = 1, 0
        for x in w:
            if cur + x > cap:
                c, cur = c + 1, 0
            cur += x
        if c <= days:
            return f"{cap}\n"


def w_parcel(inp):  # lower bound only: ignores that parcels must stay in order
    d = ints(inp)
    n, days, w = d[0], d[1], d[2 : 2 + d[0]]
    return f"{max(max(w), -(-sum(w) // days))}\n"


def g_parcel(rng, i):
    n = rng.randint(1, 8)
    return fmt(f"{n} {rng.randint(1, n)}", row([rng.randint(1, 9) for _ in range(n)]))


add(
    id="parcel-capacity",
    title="Parcel Capacity",
    diff="medium",
    pat="binary-search",
    st="A courier must deliver n parcels that are already stacked in a fixed order. Each day the truck carries a prefix of the remaining stack: it loads parcels in order until the next one would push the load above the truck's capacity, then goes out. All parcels must be delivered within the given number of days. Find the smallest truck capacity that makes this possible.",
    inf="Line 1: n and days. Line 2: n positive integers (parcel weights in stack order).",
    outf="One integer: the minimum capacity.",
    cons=["1 <= days <= n <= 20000", "1 <= weight <= 100000", "Every parcel must fit in the truck on its own"],
    solve=s_parcel,
    brute=b_parcel,
    wrong=w_parcel,
    gen=g_parcel,
    big=lambda rng: fmt("9000 37", row([rng.randint(1, 5000) for _ in range(9000)])),
    ex=[
        ("6 3\n4 2 3 7 1 5\n", "9", "Capacity 9 gives days [4,2,3], [7,1], [5]; capacity 8 would need 4 days."),
        ("3 3\n10 10 10\n", "10", "One parcel per day, so the heaviest parcel decides."),
    ],
    known=[("1 1\n7\n", "7"), ("3 3\n5 1 4\n", "5"), ("5 2\n1 2 3 4 5\n", "9"), ("4 1\n2 2 2 2\n", "8")],
)


def s_kth(inp):
    d = ints(inp)
    n, m, k = d[0], d[1], d[2]
    a, b = d[3 : 3 + n], d[3 + n : 3 + n + m]
    if n > m:
        a, b, n, m = b, a, m, n
    lo, hi = max(0, k - m), min(k, n)
    while lo < hi:  # take i items from a and k-i from b
        i = (lo + hi) // 2
        j = k - i
        if i < n and j > 0 and b[j - 1] > a[i]:
            lo = i + 1
        else:
            hi = i
    i, j = lo, k - lo
    cand = []
    if i > 0:
        cand.append(a[i - 1])
    if j > 0:
        cand.append(b[j - 1])
    return f"{max(cand)}\n"


def b_kth(inp):
    d = ints(inp)
    n, m, k = d[0], d[1], d[2]
    return f"{sorted(d[3 : 3 + n + m])[k - 1]}\n"


def w_kth(inp):  # merges the lists but drops repeated values
    d = ints(inp)
    n, m, k = d[0], d[1], d[2]
    u = sorted(set(d[3 : 3 + n + m]))
    return f"{u[min(k, len(u)) - 1]}\n"


def g_kth(rng, i):
    n, m = rng.randint(0, 6), rng.randint(0, 6)
    if n + m == 0:
        m = 1
    a, b = sorted(rng.randint(-4, 6) for _ in range(n)), sorted(rng.randint(-4, 6) for _ in range(m))
    return fmt(f"{n} {m} {rng.randint(1, n + m)}", row(a), row(b))


add(
    id="twin-archive-rank",
    title="Twin Archive Rank",
    diff="hard",
    pat="binary-search",
    st="Two archives each store their record ids in non-decreasing order (an id can repeat, even across the two archives). If all records from both archives were merged into a single sorted list, which id would sit at position k (counting from 1)? Aim for a method that does not need to merge everything.",
    inf="Line 1: n, m and k. Line 2: n integers (first archive, possibly an empty line when n = 0). Line 3: m integers (second archive, possibly an empty line when m = 0).",
    outf="One integer: the k-th smallest id in the merged multiset.",
    cons=["0 <= n, m <= 8000 and 1 <= n + m", "1 <= k <= n + m", "-1000000000 <= id <= 1000000000", "Each archive is sorted in non-decreasing order"],
    solve=s_kth,
    brute=b_kth,
    wrong=w_kth,
    gen=g_kth,
    big=lambda rng: fmt("4000 4000 4001", row(sorted(rng.randint(0, 10**5) for _ in range(4000))), row(sorted(rng.randint(0, 10**5) for _ in range(4000)))),
    ex=[
        ("3 4 5\n1 4 9\n2 3 5 8\n", "5", "Merged: 1 2 3 4 5 8 9, so position 5 holds 5."),
        ("2 3 3\n10 20\n10 15 20\n", "15", "Merged: 10 10 15 20 20; repeated ids count separately."),
    ],
    known=[("0 3 2\n\n1 2 3\n", "2"), ("2 2 4\n1 1\n1 1\n", "1"), ("1 1 2\n5\n-5\n", "5"), ("3 0 3\n1 2 3\n\n", "3")],
)


# ---------------------------------------------------------------- trees
def tree(inp):
    d = ints(inp)
    n = d[0]
    L, R, V = [-1] * n, [-1] * n, [0] * n
    for i in range(n):
        V[i], L[i], R[i] = d[1 + 3 * i : 4 + 3 * i]
    return n, V, L, R, d[1 + 3 * n :]


def gen_tree(rng, n, lo=-5, hi=9):
    L, R = [-1] * n, [-1] * n
    slots = [(0, 0), (0, 1)]
    for v in range(1, n):
        p, side = slots.pop(rng.randrange(len(slots)))
        (L if side == 0 else R)[p] = v
        slots += [(v, 0), (v, 1)]
    return [f"{rng.randint(lo, hi)} {L[i]} {R[i]}" for i in range(n)]


def s_canopy(inp):
    n, V, L, R, _ = tree(inp)
    best, st = 0, [(0, 1)]
    while st:
        v, dep = st.pop()
        best = max(best, dep)
        for c in (L[v], R[v]):
            if c != -1:
                st.append((c, dep + 1))
    return f"{best}\n"


def b_canopy(inp):
    n, V, L, R, _ = tree(inp)
    par = {c: v for v in range(n) for c in (L[v], R[v]) if c != -1}

    def depth(v):
        k = 1
        while v in par:
            v = par[v]
            k += 1
        return k

    return f"{max(depth(v) for v in range(n))}\n"


def w_canopy(inp):  # follows left children only
    n, V, L, R, _ = tree(inp)
    v, k = 0, 1
    while L[v] != -1:
        v, k = L[v], k + 1
    return f"{k}\n"


def g_canopy(rng, i):
    n = rng.randint(1, 9)
    return fmt(n, *gen_tree(rng, n))


add(
    id="canopy-height",
    title="Canopy Height",
    diff="easy",
    pat="trees",
    st="A forest ranger maps a single binary tree. Node 0 is the root, and every node record names its left child and right child (or -1 when absent). The height of the canopy is the number of nodes on the longest downward path that starts at the root. Report it.",
    inf="Line 1: n, the number of nodes. Then n lines, line i (0-based) being 'value left right' for node i, where left and right are node indices or -1. Node 0 is the root and the records always form one valid binary tree. Values are irrelevant here.",
    outf="One integer: the number of nodes on the longest root-to-leaf path.",
    cons=["1 <= n <= 2000", "-1000000000 <= value <= 1000000000", "Every node other than 0 is the child of exactly one node"],
    helpers=[tree],
    solve=s_canopy,
    brute=b_canopy,
    wrong=w_canopy,
    gen=g_canopy,
    big=lambda rng: fmt(1500, *[f"1 -1 {i + 1}" if i < 1499 else "1 -1 -1" for i in range(1500)]),
    ex=[
        ("3\n2 1 2\n1 -1 -1\n3 -1 -1\n", "2", "The root has two leaf children, so the longest path has 2 nodes."),
        ("5\n10 1 2\n20 3 -1\n30 -1 4\n40 -1 -1\n50 -1 -1\n", "3", "Paths 0-1-3 and 0-2-4 both have 3 nodes."),
    ],
    known=[("1\n5 -1 -1\n", "1"), ("4\n1 -1 1\n2 -1 2\n3 -1 3\n4 -1 -1\n", "4"), ("3\n1 1 -1\n2 2 -1\n3 -1 -1\n", "3"), ("2\n0 -1 1\n0 -1 -1\n", "2")],
)


def anc(n, L, R):
    par = [-1] * n
    for v in range(n):
        for c in (L[v], R[v]):
            if c != -1:
                par[c] = v
    return par


def s_lca(inp):
    n, V, L, R, rest = tree(inp)
    par = anc(n, L, R)
    dep = [0] * n
    order, st = [], [0]
    while st:
        v = st.pop()
        order.append(v)
        for c in (L[v], R[v]):
            if c != -1:
                dep[c] = dep[v] + 1
                st.append(c)
    q = rest[0]
    out = []
    for k in range(q):
        u, v = rest[1 + 2 * k], rest[2 + 2 * k]
        while u != v:
            if dep[u] >= dep[v]:
                u = par[u]
            else:
                v = par[v]
        out.append(u)
    return row(out) + "\n"


def b_lca(inp):
    n, V, L, R, rest = tree(inp)
    if n > 60:
        return None
    par = anc(n, L, R)

    def chain(v):
        c = [v]
        while par[v] != -1:
            v = par[v]
            c.append(v)
        return c

    out = []
    for k in range(rest[0]):
        cu, cv = chain(rest[1 + 2 * k]), set(chain(rest[2 + 2 * k]))
        out.append(next(x for x in cu if x in cv))
    return row(out) + "\n"


def w_lca(inp):  # always answers the root unless both queries are the same node
    n, V, L, R, rest = tree(inp)
    return row([rest[1 + 2 * k] if rest[1 + 2 * k] == rest[2 + 2 * k] else 0 for k in range(rest[0])]) + "\n"


def g_lca(rng, i):
    n = rng.randint(1, 9)
    q = rng.randint(1, 5)
    return fmt(n, *gen_tree(rng, n), q, *[f"{rng.randrange(n)} {rng.randrange(n)}" for _ in range(q)])


add(
    id="shared-ancestor",
    title="Shared Ancestor",
    diff="medium",
    pat="trees",
    st="A family record is a binary tree whose root, node 0, is the founder. For each query naming two members, find their closest shared ancestor: the deepest node that has both members in its subtree. A member counts as an ancestor of itself, so if one member is an ancestor of the other the answer is that member.",
    inf="Line 1: n. Then n lines 'value left right' (node i, children as indices or -1, node 0 is the root). Then a line with q, followed by q lines 'u v' naming two node indices.",
    outf="q integers separated by single spaces on one line: the closest shared ancestor of each query pair.",
    cons=["1 <= n <= 2000", "1 <= q <= 2000", "0 <= u, v < n", "The records form one valid binary tree rooted at node 0"],
    helpers=[tree, anc],
    solve=s_lca,
    brute=b_lca,
    wrong=w_lca,
    gen=g_lca,
    big=lambda rng: fmt(1500, *gen_tree(rng, 1500), 1000, *[f"{rng.randrange(1500)} {rng.randrange(1500)}" for _ in range(1000)]),
    ex=[
        ("5\n10 1 2\n20 3 -1\n30 -1 4\n40 -1 -1\n50 -1 -1\n3\n3 4\n3 1\n4 4\n", "0 1 4", "3 and 4 only meet at the root; 1 is an ancestor of 3; a node is its own ancestor."),
        ("3\n2 1 2\n1 -1 -1\n3 -1 -1\n2\n1 2\n0 1\n", "0 0", "Siblings meet at the root; the root is an ancestor of node 1."),
    ],
    known=[("1\n7 -1 -1\n1\n0 0\n", "0"), ("3\n1 1 -1\n2 2 -1\n3 -1 -1\n2\n2 1\n0 2\n", "1 0"), ("4\n0 1 2\n0 3 -1\n0 -1 -1\n0 -1 -1\n2\n3 1\n3 2\n", "1 0"), ("2\n0 -1 1\n0 -1 -1\n1\n1 1\n", "1")],
)


def s_path(inp):
    n, V, L, R, _ = tree(inp)
    par = anc(n, L, R)
    order, st = [], [0]
    while st:
        v = st.pop()
        order.append(v)
        st += [c for c in (L[v], R[v]) if c != -1]
    down = [0] * n
    best = -(10**18)
    for v in reversed(order):
        gl = max(0, down[L[v]]) if L[v] != -1 else 0
        gr = max(0, down[R[v]]) if R[v] != -1 else 0
        down[v] = V[v] + max(gl, gr)
        best = max(best, V[v] + gl + gr)
    return f"{best}\n"


def b_path(inp):
    n, V, L, R, _ = tree(inp)
    if n > 40:
        return None
    par = anc(n, L, R)

    def chain(v):
        c = [v]
        while par[v] != -1:
            v = par[v]
            c.append(v)
        return c

    best = -(10**18)
    for u in range(n):
        for v in range(n):
            cu, cv = chain(u), chain(v)
            s = set(cv)
            top = next(x for x in cu if x in s)
            nodes = set(cu[: cu.index(top) + 1]) | set(cv[: cv.index(top) + 1])
            best = max(best, sum(V[x] for x in nodes))
    return f"{best}\n"


def w_path(inp):  # best downward path from the root only (never bends)
    n, V, L, R, _ = tree(inp)
    best = -(10**18)
    st = [(0, V[0])]
    while st:
        v, s = st.pop()
        best = max(best, s)
        for c in (L[v], R[v]):
            if c != -1:
                st.append((c, s + V[c]))
    return f"{best}\n"


def g_path(rng, i):
    n = rng.randint(1, 9)
    return fmt(n, *gen_tree(rng, n, -6, 6))


add(
    id="richest-trail",
    title="Richest Trail",
    diff="hard",
    pat="trees",
    st="A cave system is a binary tree of chambers; chamber i holds treasure worth value[i], which can be negative for cursed chambers. An expedition walks a trail: a non-empty chain of chambers where consecutive chambers are directly connected, no chamber is visited twice, and the trail may start and end anywhere (it may climb up to a chamber and then descend into another branch). Find the largest total value of a trail.",
    inf="Line 1: n. Then n lines 'value left right' (node i, children as indices or -1, node 0 is the root).",
    outf="One integer: the maximum trail sum.",
    cons=["1 <= n <= 2000", "-1000000000 <= value <= 1000000000", "The records form one valid binary tree rooted at node 0"],
    helpers=[tree, anc],
    solve=s_path,
    brute=b_path,
    wrong=w_path,
    gen=g_path,
    big=lambda rng: fmt(1500, *gen_tree(rng, 1500, -1000, 1000)),
    ex=[
        ("5\n-4 1 2\n8 3 4\n6 -1 -1\n2 -1 -1\n7 -1 -1\n", "17", "Trail 3-1-4 has 2+8+7 = 17; going through the root, 4-1-0-2 gives 7+8-4+6 = 17 too."),
        ("2\n-8 1 -1\n-3 -1 -1\n", "-3", "Every chamber is cursed; the best trail is the single chamber worth -3."),
    ],
    known=[("1\n-3 -1 -1\n", "-3"), ("3\n-10 1 2\n9 -1 -1\n20 -1 -1\n", "20"), ("2\n1 1 -1\n-5 -1 -1\n", "1"), ("3\n5 1 2\n4 -1 -1\n3 -1 -1\n", "12")],
)


# ---------------------------------------------------------------- heap
def s_rope(inp):
    d = ints(inp)
    h = d[1 : 1 + d[0]]
    heapq.heapify(h)
    cost = 0
    while len(h) > 1:
        x, y = heapq.heappop(h), heapq.heappop(h)
        cost += x + y
        heapq.heappush(h, x + y)
    return f"{cost}\n"


def b_rope(inp):
    d = ints(inp)
    a = tuple(sorted(d[1 : 1 + d[0]]))
    if len(a) > 7:
        return None

    @functools.lru_cache(None)
    def go(t):
        if len(t) == 1:
            return 0
        best = None
        for i in range(len(t)):
            for j in range(i + 1, len(t)):
                rest = [t[k] for k in range(len(t)) if k not in (i, j)] + [t[i] + t[j]]
                c = t[i] + t[j] + go(tuple(sorted(rest)))
                best = c if best is None else min(best, c)
        return best

    return f"{go(a)}\n"


def w_rope(inp):  # sorted chain: always folds the running rope with the next shortest
    d = ints(inp)
    a = sorted(d[1 : 1 + d[0]])
    acc, cost = a[0], 0
    for x in a[1:]:
        acc += x
        cost += acc
    return f"{cost}\n"


def g_rope(rng, i):
    n = rng.randint(1, 7)
    return fmt(n, row([rng.randint(1, 9) for _ in range(n)]))


add(
    id="rope-splicer",
    title="Rope Splicer",
    diff="easy",
    pat="heap",
    st="A sailor has n separate ropes and wants one long rope. Splicing two ropes into one costs exactly the sum of their lengths, and the spliced rope can be spliced again. Find the smallest total cost needed to end up with a single rope (zero if there is only one).",
    inf="Line 1: n. Line 2: n positive integers (rope lengths).",
    outf="One integer: the minimum total splicing cost.",
    cons=["1 <= n <= 20000", "1 <= length <= 1000000", "The answer fits in a signed 64-bit integer"],
    solve=s_rope,
    brute=b_rope,
    wrong=w_rope,
    gen=g_rope,
    big=lambda rng: fmt(9000, row([rng.randint(1, 9000) for _ in range(9000)])),
    ex=[
        ("4\n4 3 2 6\n", "29", "Splice 2+3=5 (cost 5), 4+5=9 (cost 9), 6+9=15 (cost 15): 29."),
        ("5\n1 1 1 1 1\n", "12", "Costs 2, 2, 3 and 5 in a balanced order."),
    ],
    known=[("1\n9\n", "0"), ("4\n1 1 1 1\n", "8"), ("3\n1 2 3\n", "9"), ("2\n5 5\n", "10")],
)


def s_feeds(inp):
    d = ints(inp)
    k, pos, lists = d[0], 1, []
    for _ in range(k):
        m = d[pos]
        lists.append(d[pos + 1 : pos + 1 + m])
        pos += 1 + m
    h = [(l[0], i, 0) for i, l in enumerate(lists) if l]
    heapq.heapify(h)
    out = []
    while h:
        v, i, j = heapq.heappop(h)
        out.append(v)
        if j + 1 < len(lists[i]):
            heapq.heappush(h, (lists[i][j + 1], i, j + 1))
    return row(out) + "\n"


def b_feeds(inp):
    d = ints(inp)
    k, pos, allv = d[0], 1, []
    for _ in range(k):
        m = d[pos]
        allv += d[pos + 1 : pos + 1 + m]
        pos += 1 + m
    return row(sorted(allv)) + "\n"


def w_feeds(inp):  # drops duplicates while merging
    d = ints(inp)
    k, pos, allv = d[0], 1, set()
    for _ in range(k):
        m = d[pos]
        allv |= set(d[pos + 1 : pos + 1 + m])
        pos += 1 + m
    return row(sorted(allv)) + "\n"


def g_feeds(rng, i):
    k = rng.randint(1, 4)
    ls = [sorted(rng.randint(-3, 5) for _ in range(rng.randint(0, 4))) for _ in range(k)]
    if not any(ls):
        ls[0] = [rng.randint(0, 3)]
    return fmt(k, *[f"{len(l)} {row(l)}".strip() for l in ls])


add(
    id="feed-merger",
    title="Feed Merger",
    diff="medium",
    pat="heap",
    st="A news reader subscribes to k feeds. Every feed lists its post timestamps in non-decreasing order, and some feeds may currently be empty. Produce a single combined timeline of all timestamps in non-decreasing order, keeping every duplicate.",
    inf="Line 1: k. Then k lines; each starts with the feed length m followed by its m timestamps (a line is just '0' for an empty feed).",
    outf="All timestamps of all feeds in non-decreasing order, separated by single spaces on one line. At least one feed is non-empty.",
    cons=["1 <= k <= 500", "0 <= m, and the total number of timestamps is between 1 and 8000", "-1000000000 <= timestamp <= 1000000000", "Each feed is sorted in non-decreasing order"],
    solve=s_feeds,
    brute=b_feeds,
    wrong=w_feeds,
    gen=g_feeds,
    big=lambda rng: fmt(200, *[f"40 {row(sorted(rng.randint(0, 9999) for _ in range(40)))}" for _ in range(200)]),
    ex=[
        ("3\n3 1 4 9\n2 2 3\n3 0 5 6\n", "0 1 2 3 4 5 6 9", "The three sorted feeds interleave into one timeline."),
        ("2\n2 -5 5\n2 -5 5\n", "-5 -5 5 5", "Duplicates from different feeds are all kept."),
    ],
    known=[("2\n0\n3 1 2 3\n", "1 2 3"), ("3\n2 1 1\n1 1\n1 1\n", "1 1 1 1"), ("1\n1 42\n", "42"), ("4\n1 7\n0\n1 -7\n0\n", "-7 7")],
)


def s_median(inp):
    d = ints(inp)
    lo, hi, out = [], [], []  # lo: max-heap (negated), hi: min-heap; |lo| == |hi| or |hi| + 1
    for x in d[1 : 1 + d[0]]:
        if lo and x > -lo[0]:
            heapq.heappush(hi, x)
        else:
            heapq.heappush(lo, -x)
        if len(lo) > len(hi) + 1:
            heapq.heappush(hi, -heapq.heappop(lo))
        elif len(hi) > len(lo):
            heapq.heappush(lo, -heapq.heappop(hi))
        out.append(-lo[0])
    return row(out) + "\n"


def b_median(inp):
    d = ints(inp)
    a = d[1 : 1 + d[0]]
    if len(a) > 400:
        return None
    return row([sorted(a[: i + 1])[i // 2] for i in range(len(a))]) + "\n"


def w_median(inp):  # reports the upper middle value when the count is even
    d = ints(inp)
    a = d[1 : 1 + d[0]]
    return row([sorted(a[: i + 1])[(i + 1) // 2] for i in range(len(a))]) + "\n"


def g_median(rng, i):
    n = rng.randint(1, 9)
    return fmt(n, row([rng.randint(-5, 9) for _ in range(n)]))


add(
    id="drift-median",
    title="Drift Median",
    diff="hard",
    pat="heap",
    st="Sensor readings arrive one at a time. After each new reading, report the median of all readings received so far; if an even number of readings has arrived, report the lower of the two middle values (so the answer is always one of the readings).",
    inf="Line 1: n. Line 2: n integers in arrival order.",
    outf="n integers separated by single spaces on one line: the median after each arrival.",
    cons=["1 <= n <= 20000", "-1000000000 <= reading <= 1000000000"],
    solve=s_median,
    brute=b_median,
    wrong=w_median,
    gen=g_median,
    big=lambda rng: fmt(9000, row([rng.randint(-1000, 1000) for _ in range(9000)])),
    ex=[
        ("5\n2 8 1 9 4\n", "2 2 2 2 4", "Prefix medians: [2]->2, [2,8]->2 (lower), [1,2,8]->2, [1,2,8,9]->2 (lower), [1,2,4,8,9]->4."),
        ("4\n10 -10 0 5\n", "10 -10 0 0", "Sorted prefixes: [10], [-10,10], [-10,0,10], [-10,0,5,10]."),
    ],
    known=[("1\n5\n", "5"), ("2\n1 3\n", "1 1"), ("4\n5 4 3 2\n", "5 4 4 3"), ("3\n-1 -1 -1\n", "-1 -1 -1")],
)


# ---------------------------------------------------------------- backtracking
def s_charm(inp):
    d = ints(inp)
    n, t, a = d[0], d[1], d[2 : 2 + d[0]]
    ways = Counter({0: 1})
    for x in a:
        nxt = Counter(ways)
        for s, c in ways.items():
            nxt[s + x] += c
        ways = nxt
    return f"{ways[t]}\n"


def b_charm(inp):
    d = ints(inp)
    n, t, a = d[0], d[1], d[2 : 2 + d[0]]
    if n > 14:
        return None
    return f"{sum(1 for m in range(1 << n) if sum(a[i] for i in range(n) if m >> i & 1) == t)}\n"


def w_charm(inp):  # treats charms with equal values as interchangeable
    d = ints(inp)
    n, t, a = d[0], d[1], d[2 : 2 + d[0]]
    seen = set()
    for m in range(1 << n):
        seen.add(tuple(sorted(a[i] for i in range(n) if m >> i & 1)) if sum(a[i] for i in range(n) if m >> i & 1) == t else None)
    seen.discard(None)
    return f"{len(seen)}\n"


def g_charm(rng, i):
    n = rng.randint(1, 8)
    return fmt(f"{n} {rng.randint(-3, 6)}", row([rng.randint(-3, 4) for _ in range(n)]))


add(
    id="charm-bracelet",
    title="Charm Bracelet",
    diff="medium",
    pat="backtracking",
    st="A jeweller has n distinct charms, each with an integer weight in grams (a charm may be negative if it is a lighter-than-air float). A bracelet uses any subset of the charms, including no charms at all, and its weight is the sum of the chosen charms. Two bracelets are different if they use different physical charms, even when their weights match. Count the bracelets whose total weight is exactly the target.",
    inf="Line 1: n and target separated by a space. Line 2: n integers (the charm weights).",
    outf="One integer: the number of subsets (by charm, not by value) whose sum equals the target.",
    cons=["1 <= n <= 20", "-50 <= weight <= 50", "-1000 <= target <= 1000"],
    solve=s_charm,
    brute=b_charm,
    wrong=w_charm,
    gen=g_charm,
    big=lambda rng: fmt("20 0", row([rng.randint(-5, 5) for _ in range(20)])),
    ex=[
        ("4 6\n1 2 3 3\n", "3", "{1,2,3a}, {1,2,3b} and {3a,3b}; the two 3-gram charms are different charms."),
        ("3 -2\n-1 -1 5\n", "1", "Only the two negative charms together reach -2."),
    ],
    known=[("3 0\n0 0 0\n", "8"), ("1 0\n5\n", "1"), ("2 5\n5 5\n", "2"), ("3 3\n1 2 3\n", "2")],
)


def s_sentry(inp):
    t = inp.split()
    n, g = int(t[0]), t[1 : 1 + int(t[0])]
    full = (1 << n) - 1
    blocked = [sum(1 << c for c in range(n) if g[r][c] == "#") for r in range(n)]

    def go(r, cols, d1, d2):
        if r == n:
            return 1
        free = full & ~(cols | d1 | d2 | blocked[r])
        tot = 0
        while free:
            bit = free & -free
            free ^= bit
            tot += go(r + 1, cols | bit, ((d1 | bit) << 1) & full, (d2 | bit) >> 1)
        return tot

    return f"{go(0, 0, 0, 0)}\n"


def b_sentry(inp):
    t = inp.split()
    n, g = int(t[0]), t[1 : 1 + int(t[0])]
    if n > 7:
        return None
    return f"{sum(1 for p in permutations(range(n)) if all(g[r][p[r]] == '.' for r in range(n)) and all(abs(p[a] - p[b]) != b - a for a in range(n) for b in range(a + 1, n)))}\n"


def w_sentry(inp):  # ignores the blocked cells
    t = inp.split()
    n = int(t[0])
    return s_sentry(fmt(n, *["." * n] * n))


def g_sentry(rng, i):
    n = rng.randint(1, 6)
    return fmt(n, *["".join("#" if rng.random() < 0.18 else "." for _ in range(n)) for _ in range(n)])


add(
    id="sentry-grid",
    title="Sentry Grid",
    diff="medium",
    pat="backtracking",
    st="A fortress courtyard is an n x n grid; some cells are rubble ('#') where nothing can be built, and the rest are free ('.'). Place exactly n sentry towers on free cells so that no two towers share a row, a column, or a diagonal (towers see along all of these lines; rubble does not block their view). Count the different placements.",
    inf="Line 1: n. Then n lines of n characters, each '.' (free) or '#' (rubble).",
    outf="One integer: the number of valid placements of n towers.",
    cons=["1 <= n <= 10", "Each grid line has exactly n characters from '.' and '#'"],
    solve=s_sentry,
    brute=b_sentry,
    wrong=w_sentry,
    gen=g_sentry,
    big=lambda rng: fmt(10, *["." * 10] * 10),
    ex=[
        ("4\n....\n....\n....\n....\n", "2", "On an open 4x4 courtyard there are exactly two placements (mirror images)."),
        ("4\n.#..\n....\n....\n....\n", "1", "Rubble at row 0, column 1 removes one of the two placements."),
    ],
    known=[("1\n.\n", "1"), ("1\n#\n", "0"), ("2\n..\n..\n", "0"), ("5\n.....\n.....\n.....\n.....\n.....\n", "10"), ("6\n......\n......\n......\n......\n......\n......\n", "4")],
)


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


def b_pass(inp):
    s = inp.strip()
    return "\n".join(sorted({"".join(p) for p in permutations(s)})) + "\n"


def w_pass(inp):  # forgets that equal letters make duplicate codes
    s = inp.strip()
    return "\n".join(sorted("".join(p) for p in permutations(s))) + "\n"


def g_pass(rng, i):
    return "".join(rng.choice("abc") for _ in range(rng.randint(2, 5))) + "\n"


add(
    id="passcode-roster",
    title="Passcode Roster",
    diff="medium",
    pat="backtracking",
    st="A vault is opened by a passcode that uses every character of a given multiset of letters exactly once, in any order. Print every distinct passcode that can be formed, one per line, in alphabetical (lexicographic) order, with no repeats.",
    inf="A single line with a string of 1 to 7 lowercase letters (letters may repeat).",
    outf="Every distinct arrangement of those letters, one per line, in lexicographic order.",
    cons=["1 <= length <= 7", "Only lowercase letters a-z", "At most 5040 lines of output"],
    solve=s_pass,
    brute=b_pass,
    wrong=w_pass,
    gen=g_pass,
    big=lambda rng: "abcdefg\n",
    ex=[
        ("abc\n", "abc\nacb\nbac\nbca\ncab\ncba", "All six arrangements of three different letters."),
        ("xyy\n", "xyy\nyxy\nyyx", "The two y's are identical, so only three distinct codes exist."),
    ],
    known=[("a\n", "a"), ("aa\n", "aa"), ("ab\n", "ab\nba"), ("aab\n", "aab\naba\nbaa"), ("zzzz\n", "zzzz")],
)
