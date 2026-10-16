"""Batch 4: linked-lists, tries, advanced-graphs, intervals, math-geometry, bit-manipulation (new problems)."""
import sys, heapq, bisect, math, itertools, functools  # noqa: F401,E401
from collections import *  # noqa: F401,F403
from itertools import permutations
from lib import add, ints, row, fmt  # noqa: F401


# ---------------------------------------------------------------- linked-lists
def s_cars(inp):
    d = ints(inp)
    n, k = d[0], d[1]
    val = d[2 : 2 + n]
    nxt = [i + 1 for i in range(n)]
    nxt[-1] = -1  # singly linked: node i -> node i+1
    head, prev_tail = 0, -1
    cur = 0
    new_head = None
    while cur != -1:
        # find the k-th node from cur; skip the group if fewer than k nodes remain
        probe, cnt = cur, 0
        while probe != -1 and cnt < k:
            probe, cnt = nxt[probe], cnt + 1
        if cnt < k:
            if prev_tail != -1:
                nxt[prev_tail] = cur
            break
        # reverse k nodes starting at cur; `probe` is the node after the group
        prev, node = probe, cur
        for _ in range(k):
            nxt[node], prev, node = prev, node, nxt[node]
        if new_head is None:
            new_head = prev
        else:
            nxt[prev_tail] = prev
        prev_tail = cur
        cur = probe
    out, p = [], new_head if new_head is not None else 0
    while p != -1:
        out.append(val[p])
        p = nxt[p]
    return row(out) + "\n"


def b_cars(inp):
    d = ints(inp)
    n, k, a = d[0], d[1], d[2 : 2 + d[0]]
    out = []
    for i in range(0, n, k):
        chunk = a[i : i + k]
        out += chunk[::-1] if len(chunk) == k else chunk
    return row(out) + "\n"


def w_cars(inp):  # also reverses the short final group
    d = ints(inp)
    n, k, a = d[0], d[1], d[2 : 2 + d[0]]
    out = []
    for i in range(0, n, k):
        out += a[i : i + k][::-1]
    return row(out) + "\n"


def g_cars(rng, i):
    n = rng.randint(1, 9)
    return fmt(f"{n} {rng.randint(1, n + 1)}", row([rng.randint(0, 20) for _ in range(n)]))


add(
    id="coupled-cars",
    title="Coupled Cars",
    diff="medium",
    pat="linked-lists",
    st="A freight train is a chain of n cars coupled one after another; each car holds a cargo number. The yard crew must flip the chain in blocks of k: the first k cars are reversed as a block, then the next k cars, and so on. If fewer than k cars remain at the end, that last short block is left exactly as it is. Output the cargo numbers from the front of the reordered train to the back.",
    inf="Line 1: n and k. Line 2: n integers (cargo numbers from front to back).",
    outf="n integers separated by single spaces on one line.",
    cons=["1 <= k <= n + 1 and 1 <= n <= 20000", "-1000000000 <= cargo <= 1000000000", "k may exceed n, in which case nothing changes"],
    solve=s_cars,
    brute=b_cars,
    wrong=w_cars,
    gen=g_cars,
    big=lambda rng: fmt("9000 7", row([rng.randint(0, 9999) for _ in range(9000)])),
    ex=[
        ("6 3\n1 2 3 4 5 6\n", "3 2 1 6 5 4", "Two full blocks of three are each reversed."),
        ("7 2\n10 20 30 40 50 60 70\n", "20 10 40 30 60 50 70", "The leftover single car 70 stays put."),
    ],
    known=[("1 1\n5\n", "5"), ("5 2\n1 2 3 4 5\n", "2 1 4 3 5"), ("5 3\n1 2 3 4 5\n", "3 2 1 4 5"), ("4 4\n1 2 3 4\n", "4 3 2 1"), ("3 5\n1 2 3\n", "1 2 3")],
)


def s_loop(inp):
    d = ints(inp)
    n = d[0]
    nxt = [d[2 + 2 * i] for i in range(n)]
    slow = fast = 0
    while True:
        if fast == -1 or nxt[fast] == -1:
            return "-1\n"
        slow, fast = nxt[slow], nxt[nxt[fast]]
        if slow == fast:
            break
    slow = 0
    while slow != fast:
        slow, fast = nxt[slow], nxt[fast]
    return f"{slow}\n"


def b_loop(inp):
    d = ints(inp)
    n = d[0]
    nxt = [d[2 + 2 * i] for i in range(n)]
    seen, p = set(), 0
    while p != -1:
        if p in seen:
            return f"{p}\n"
        seen.add(p)
        p = nxt[p]
    return "-1\n"


def w_loop(inp):  # reports where the two runners first meet, not where the loop starts
    d = ints(inp)
    n = d[0]
    nxt = [d[2 + 2 * i] for i in range(n)]
    slow = fast = 0
    while True:
        if fast == -1 or nxt[fast] == -1:
            return "-1\n"
        slow, fast = nxt[slow], nxt[nxt[fast]]
        if slow == fast:
            return f"{slow}\n"


def g_loop(rng, i):
    n = rng.randint(1, 8)
    order = [0] + rng.sample(range(1, n), n - 1)
    nxt = [-1] * n
    for a, b in zip(order, order[1:]):
        nxt[a] = b
    nxt[order[-1]] = rng.choice([-1] + order)
    return fmt(n, *[f"{rng.randint(0, 9)} {nxt[v]}" for v in range(n)])


add(
    id="loop-entry",
    title="Loop Entry",
    diff="medium",
    pat="linked-lists",
    st="A pipeline of n stages is stored as records: stage i has a payload and a 'next' stage index, or -1 if the pipeline ends there. Processing always begins at stage 0 and follows the 'next' links. A faulty record may send the flow back to an earlier stage, so it circles forever. If the flow never ends, report the first stage that is visited twice (the entry point of the loop); if it ends at a -1 link, report -1.",
    inf="Line 1: n. Then n lines, line i holding 'payload next' for stage i (next is a stage index or -1).",
    outf="One integer: the stage index where the loop begins, or -1 if there is no loop.",
    cons=["1 <= n <= 20000", "-1000000000 <= payload <= 1000000000", "-1 <= next < n"],
    solve=s_loop,
    brute=b_loop,
    wrong=w_loop,
    gen=g_loop,
    big=lambda rng: fmt(6000, *[f"{i % 97} {i + 1}" for i in range(5999)], "0 2500"),
    ex=[
        ("5\n10 1\n20 2\n30 3\n40 4\n50 2\n", "2", "Stages 2, 3, 4 form a loop; flow enters it at stage 2."),
        ("3\n7 1\n8 2\n9 -1\n", "-1", "The flow ends at stage 2."),
    ],
    known=[("1\n5 -1\n", "-1"), ("1\n5 0\n", "0"), ("3\n1 1\n2 2\n3 1\n", "1"), ("4\n1 1\n2 2\n3 3\n4 -1\n", "-1"), ("4\n1 1\n2 2\n3 3\n4 2\n", "2")],
)


# ---------------------------------------------------------------- tries
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


def b_dir(inp):
    t = inp.split()
    n, q = int(t[0]), int(t[1])
    if n > 200:
        return None
    ws = t[2 : 2 + n]
    return row([sum(1 for w in ws if w.startswith(p)) for p in t[2 + n : 2 + n + q]]) + "\n"


def w_dir(inp):  # counts distinct words only
    t = inp.split()
    n, q = int(t[0]), int(t[1])
    ws = set(t[2 : 2 + n])
    return row([sum(1 for w in ws if w.startswith(p)) for p in t[2 + n : 2 + n + q]]) + "\n"


def g_dir(rng, i):
    n, q = rng.randint(1, 7), rng.randint(1, 4)
    ws = ["".join(rng.choice("ab") for _ in range(rng.randint(1, 4))) for _ in range(n)]
    ps = ["".join(rng.choice("ab") for _ in range(rng.randint(1, 3))) for _ in range(q)]
    return fmt(f"{n} {q}", *ws, *ps)


add(
    id="prefix-directory",
    title="Prefix Directory",
    diff="medium",
    pat="tries",
    st="A phone directory stores n names (lowercase words); the same name can be stored several times, and each stored copy counts. For each of q search prefixes, report how many stored names start with that prefix. A name starts with a prefix if the prefix is its first few letters (a name starts with itself).",
    inf="Line 1: n and q. Then n lines, one stored name each. Then q lines, one prefix each.",
    outf="q integers separated by single spaces on one line.",
    cons=["1 <= n, q <= 5000", "Names and prefixes have 1 to 20 lowercase letters", "The whole input is at most 64 KiB"],
    solve=s_dir,
    brute=b_dir,
    wrong=w_dir,
    gen=g_dir,
    big=lambda rng: fmt("3000 1500", *["".join(rng.choice("abc") for _ in range(rng.randint(1, 10))) for _ in range(3000)], *["".join(rng.choice("abc") for _ in range(rng.randint(1, 4))) for _ in range(1500)]),
    ex=[
        ("5 3\nsolar\nsolid\nsolo\nsun\nsolar\nso\nsol\nsu\n", "4 4 1", "'so' and 'sol' match solar (x2), solid and solo; 'su' matches sun."),
        ("2 2\nbee\nbeetle\nbeet\nx\n", "1 0", "Only beetle starts with beet; nothing starts with x."),
    ],
    known=[("1 1\na\na\n", "1"), ("3 2\nab\nab\nabc\nab\nb\n", "3 0"), ("2 3\napple\napply\nap\napp\nappl\n", "2 2 2"), ("2 2\nabc\nabd\nabcd\nz\n", "0 0")],
)


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


def b_wild(inp):
    t = inp.split()
    n, q = int(t[0]), int(t[1])
    ws = t[2 : 2 + n]
    return " ".join("YES" if any(len(w) == len(p) and all(a == b or b == "." for a, b in zip(w, p)) for w in ws) else "NO" for p in t[2 + n : 2 + n + q]) + "\n"


def w_wild(inp):  # prefix match: forgets the word must end where the pattern ends
    t = inp.split()
    n, q = int(t[0]), int(t[1])
    ws = t[2 : 2 + n]
    return " ".join("YES" if any(len(w) >= len(p) and all(a == b or b == "." for a, b in zip(w, p)) for w in ws) else "NO" for p in t[2 + n : 2 + n + q]) + "\n"


def g_wild(rng, i):
    n, q = rng.randint(1, 5), rng.randint(1, 5)
    ws = ["".join(rng.choice("ab") for _ in range(rng.randint(1, 3))) for _ in range(n)]
    ps = ["".join(rng.choice("ab.") for _ in range(rng.randint(1, 3))) for _ in range(q)]
    return fmt(f"{n} {q}", *ws, *ps)


add(
    id="wildcard-lexicon",
    title="Wildcard Lexicon",
    diff="hard",
    pat="tries",
    st="A crossword helper stores n words. Each query is a pattern of the same length as the word wanted, where a '.' stands for exactly one unknown letter and any other character must match exactly. For every pattern answer whether at least one stored word fits it completely (same length, every position compatible).",
    inf="Line 1: n and q. Then n lines, one lowercase word each. Then q lines, one pattern each (lowercase letters and '.').",
    outf="q tokens YES or NO separated by single spaces on one line.",
    cons=["1 <= n, q <= 3000", "Words and patterns have 1 to 20 characters", "Words contain only lowercase letters; patterns also allow '.'"],
    solve=s_wild,
    brute=b_wild,
    wrong=w_wild,
    gen=g_wild,
    big=lambda rng: fmt("2500 1200", *["".join(rng.choice("abc") for _ in range(rng.randint(3, 8))) for _ in range(2500)], *["".join(rng.choice("abc..") for _ in range(rng.randint(3, 8))) for _ in range(1200)]),
    ex=[
        ("4 4\nmask\nmast\nmile\nmole\nm.st\nm.l.\nm..\n....\n", "YES YES NO YES", "m..: no stored word has exactly three letters."),
        ("2 3\nzz\nzy\n.z\nz.\n.x\n", "YES YES NO", "No stored word ends in x."),
    ],
    known=[("1 1\na\na\n", "YES"), ("1 4\nabc\nab\nabcd\n.b.\n...\n", "NO NO YES YES"), ("2 2\ncat\ncar\ncb.\n..r\n", "NO YES"), ("1 1\nab\n..\n", "YES")],
)


# ---------------------------------------------------------------- advanced-graphs
def s_order(inp):
    d = ints(inp)
    n, m = d[0], d[1]
    adj, indeg = [[] for _ in range(n + 1)], [0] * (n + 1)
    for i in range(m):
        u, v = d[2 + 2 * i], d[3 + 2 * i]
        adj[u].append(v)
        indeg[v] += 1
    h = [v for v in range(1, n + 1) if indeg[v] == 0]
    heapq.heapify(h)
    out = []
    while h:
        u = heapq.heappop(h)
        out.append(u)
        for v in adj[u]:
            indeg[v] -= 1
            if indeg[v] == 0:
                heapq.heappush(h, v)
    return row(out) + "\n" if len(out) == n else "IMPOSSIBLE\n"


def b_order(inp):
    d = ints(inp)
    n, m = d[0], d[1]
    if n > 7:
        return None
    E = [(d[2 + 2 * i], d[3 + 2 * i]) for i in range(m)]
    for p in permutations(range(1, n + 1)):  # lexicographic order of permutations
        pos = {v: i for i, v in enumerate(p)}
        if all(pos[u] < pos[v] for u, v in E):
            return row(p) + "\n"
    return "IMPOSSIBLE\n"


def w_order(inp):  # plain first-in-first-out queue instead of always taking the smallest ready course
    d = ints(inp)
    n, m = d[0], d[1]
    adj, indeg = [[] for _ in range(n + 1)], [0] * (n + 1)
    for i in range(m):
        u, v = d[2 + 2 * i], d[3 + 2 * i]
        adj[u].append(v)
        indeg[v] += 1
    q = deque(v for v in range(1, n + 1) if indeg[v] == 0)
    out = []
    while q:
        u = q.popleft()
        out.append(u)
        for v in adj[u]:
            indeg[v] -= 1
            if indeg[v] == 0:
                q.append(v)
    return row(out) + "\n" if len(out) == n else "IMPOSSIBLE\n"


def g_order(rng, i):
    n = rng.randint(1, 6)
    m = rng.randint(0, 7)
    es = []
    for _ in range(m):
        if n < 2:
            break
        u, v = rng.sample(range(1, n + 1), 2)
        if i != 4 and u > v:
            u, v = v, u  # mostly acyclic; case 4 may contain cycles
        es.append(f"{u} {v}")
    return fmt(f"{n} {len(es)}", *es)


add(
    id="course-sequence",
    title="Course Sequence",
    diff="medium",
    pat="advanced-graphs",
    st="A college offers n courses numbered 1..n. A list of m requirements says course u must be completed before course v. A student takes one course at a time and wants a full schedule that respects every requirement. Among all valid schedules, print the one that is smallest in dictionary order of the sequence (compare the first course, then the second, and so on). If the requirements contradict each other, no schedule exists.",
    inf="Line 1: n and m. Then m lines, each 'u v' meaning u must come before v.",
    outf="The n course numbers separated by single spaces on one line, or IMPOSSIBLE.",
    cons=["1 <= n <= 5000", "0 <= m <= 8000", "1 <= u, v <= n and u != v (a pair may repeat)"],
    solve=s_order,
    brute=b_order,
    wrong=w_order,
    gen=g_order,
    big=lambda rng: fmt("3000 2999", *[f"{3000 - i} {2999 - i}" for i in range(2999)]),
    ex=[
        ("5 4\n5 1\n4 1\n1 2\n3 2\n", "3 4 5 1 2", "Ready set starts {3,4,5}: take 3, then 4, then 5, which unlocks 1, then 2."),
        ("3 3\n1 2\n2 3\n3 1\n", "IMPOSSIBLE", "The requirements form a circle."),
    ],
    known=[("3 0\n", "1 2 3"), ("4 2\n4 1\n3 2\n", "3 2 4 1"), ("2 2\n1 2\n2 1\n", "IMPOSSIBLE"), ("1 0\n", "1")],
)


def s_route(inp):
    d = ints(inp)
    n, m = d[0], d[1]
    adj = [[] for _ in range(n + 1)]
    for i in range(m):
        u, v, w = d[2 + 3 * i : 5 + 3 * i]
        adj[u].append((v, w))
    INF = float("inf")
    dist = [INF] * (n + 1)
    dist[1] = 0
    h = [(0, 1)]
    while h:
        dd, u = heapq.heappop(h)
        if dd > dist[u]:
            continue
        for v, w in adj[u]:
            if dd + w < dist[v]:
                dist[v] = dd + w
                heapq.heappush(h, (dist[v], v))
    return f"{dist[n] if dist[n] < INF else -1}\n"


def b_route(inp):  # Bellman-Ford
    d = ints(inp)
    n, m = d[0], d[1]
    E = [tuple(d[2 + 3 * i : 5 + 3 * i]) for i in range(m)]
    INF = float("inf")
    dist = [INF] * (n + 1)
    dist[1] = 0
    for _ in range(n):
        for u, v, w in E:
            if dist[u] + w < dist[v]:
                dist[v] = dist[u] + w
    return f"{dist[n] if dist[n] < INF else -1}\n"


def w_route(inp):  # fewest roads first (BFS), then report that route's toll
    d = ints(inp)
    n, m = d[0], d[1]
    adj = [[] for _ in range(n + 1)]
    for i in range(m):
        u, v, w = d[2 + 3 * i : 5 + 3 * i]
        adj[u].append((v, w))
    cost = {1: 0}
    dq = deque([1])
    while dq:
        u = dq.popleft()
        for v, w in adj[u]:
            if v not in cost:
                cost[v] = cost[u] + w
                dq.append(v)
    return f"{cost.get(n, -1)}\n"


def g_route(rng, i):
    n = rng.randint(1, 7)
    m = rng.randint(0, 10)
    es = []
    for _ in range(m):
        if n < 2:
            break
        u, v = rng.sample(range(1, n + 1), 2)
        es.append(f"{u} {v} {rng.randint(1, 9)}")
    return fmt(f"{n} {len(es)}", *es)


add(
    id="cheapest-route",
    title="Cheapest Route",
    diff="medium",
    pat="advanced-graphs",
    st="A delivery company has n depots numbered 1..n connected by m one-way roads; each road has a toll. Find the smallest total toll to get from depot 1 to depot n, or report -1 if depot n cannot be reached. Reaching depot 1 itself when n = 1 costs 0.",
    inf="Line 1: n and m. Then m lines, each 'u v w': a one-way road from u to v with toll w.",
    outf="One integer: the minimum total toll, or -1 if unreachable.",
    cons=["1 <= n <= 2000", "0 <= m <= 6000", "1 <= u, v <= n and u != v", "1 <= w <= 1000000000", "Parallel roads are possible"],
    solve=s_route,
    brute=b_route,
    wrong=w_route,
    gen=g_route,
    big=lambda rng: fmt("1500 4000", *[f"{rng.randint(1, 1499)} {rng.randint(2, 1500)} {rng.randint(1, 1000)}" for _ in range(3999)], "1 1500 5000"),
    ex=[
        ("5 6\n1 2 4\n1 3 1\n3 2 2\n2 4 1\n3 4 6\n4 5 3\n", "7", "1 -> 3 -> 2 -> 4 -> 5 costs 1+2+1+3 = 7."),
        ("4 2\n1 2 5\n3 4 1\n", "-1", "Depot 4 is only reachable from depot 3."),
    ],
    known=[("1 0\n", "0"), ("2 0\n", "-1"), ("3 3\n1 3 10\n1 2 1\n2 3 1\n", "2"), ("3 1\n3 1 5\n", "-1"), ("2 2\n1 2 1000000000\n1 2 5\n", "5")],
)


# ---------------------------------------------------------------- intervals
def s_merge(inp):
    d = ints(inp)
    iv = sorted((d[1 + 2 * i], d[2 + 2 * i]) for i in range(d[0]))
    out = []
    for s, e in iv:
        if out and s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return f"{len(out)}\n" + "\n".join(f"{s} {e}" for s, e in out) + "\n"


def b_merge(inp):  # connected components of the pairwise-overlap graph
    d = ints(inp)
    n = d[0]
    iv = [(d[1 + 2 * i], d[2 + 2 * i]) for i in range(n)]
    if n > 60:
        return None
    comp = list(range(n))

    def find(x):
        while comp[x] != x:
            x = comp[x]
        return x

    for i in range(n):
        for j in range(i + 1, n):
            if iv[i][0] <= iv[j][1] and iv[j][0] <= iv[i][1]:
                comp[find(i)] = find(j)
    groups = defaultdict(list)
    for i in range(n):
        groups[find(i)].append(iv[i])
    res = sorted((min(s for s, _ in g), max(e for _, e in g)) for g in groups.values())
    return f"{len(res)}\n" + "\n".join(f"{s} {e}" for s, e in res) + "\n"


def w_merge(inp):  # intervals that merely touch are kept apart
    d = ints(inp)
    iv = sorted((d[1 + 2 * i], d[2 + 2 * i]) for i in range(d[0]))
    out = []
    for s, e in iv:
        if out and s < out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return f"{len(out)}\n" + "\n".join(f"{s} {e}" for s, e in out) + "\n"


def g_merge(rng, i):
    n = rng.randint(1, 7)
    iv = []
    for _ in range(n):
        s = rng.randint(0, 12)
        iv.append(f"{s} {s + rng.randint(0, 4)}")
    return fmt(n, *iv)


add(
    id="booking-merge",
    title="Booking Merge",
    diff="easy",
    pat="intervals",
    st="A hall receives n booking requests, each a closed range of days [start, end] that includes both end days. Two requests that share at least one day (including when one ends on the very day the other starts) must be combined into a single continuous block. Output the final non-overlapping blocks in increasing order.",
    inf="Line 1: n. Then n lines, each 'start end' with start <= end.",
    outf="First a line with the number k of blocks, then k lines 'start end' in increasing order of start.",
    cons=["1 <= n <= 5000", "0 <= start <= end <= 1000000000"],
    solve=s_merge,
    brute=b_merge,
    wrong=w_merge,
    gen=g_merge,
    big=lambda rng: fmt(4000, *[f"{(s := rng.randint(0, 100000))} {s + rng.randint(0, 40)}" for _ in range(4000)]),
    ex=[
        ("5\n9 12\n1 4\n3 5\n20 21\n12 15\n", "3\n1 5\n9 15\n20 21", "1-4 and 3-5 overlap; 9-12 and 12-15 share day 12."),
        ("3\n7 7\n5 6\n6 7\n", "1\n5 7", "Day 6 links the first pair; day 7 links in the single-day booking."),
    ],
    known=[("1\n1 1\n", "1\n1 1"), ("2\n1 3\n3 5\n", "1\n1 5"), ("2\n1 2\n4 5\n", "2\n1 2\n4 5"), ("3\n5 6\n1 10\n2 3\n", "1\n1 10"), ("2\n0 0\n0 0\n", "1\n0 0")],
)


def s_rooms(inp):
    d = ints(inp)
    ev = []
    for i in range(d[0]):
        ev.append((d[1 + 2 * i], 1))
        ev.append((d[2 + 2 * i], -1))
    ev.sort()  # at equal times the -1 (end) sorts before +1 (start): half-open intervals
    cur = best = 0
    for _, delta in ev:
        cur += delta
        best = max(best, cur)
    return f"{best}\n"


def b_rooms(inp):
    d = ints(inp)
    iv = [(d[1 + 2 * i], d[2 + 2 * i]) for i in range(d[0])]
    if max(e for _, e in iv) > 100000:
        return None
    return f"{max(sum(1 for s, e in iv if s <= t < e) for t in {s for s, _ in iv})}\n"


def w_rooms(inp):  # counts an ending meeting and a starting meeting at the same minute as overlapping
    d = ints(inp)
    ev = []
    for i in range(d[0]):
        ev.append((d[1 + 2 * i], 1))
        ev.append((d[2 + 2 * i], -1))
    ev.sort(key=lambda x: (x[0], -x[1]))
    cur = best = 0
    for _, delta in ev:
        cur += delta
        best = max(best, cur)
    return f"{best}\n"


def g_rooms(rng, i):
    n = rng.randint(1, 7)
    iv = []
    for _ in range(n):
        s = rng.randint(0, 8)
        iv.append(f"{s} {s + rng.randint(1, 4)}")
    return fmt(n, *iv)


add(
    id="room-juggler",
    title="Room Juggler",
    diff="medium",
    pat="intervals",
    st="A conference has n sessions, session i running from minute start[i] up to but not including minute end[i]. A session that ends at minute t frees its room for a session that starts at minute t. What is the smallest number of rooms that lets all sessions run as scheduled?",
    inf="Line 1: n. Then n lines, each 'start end' with start < end.",
    outf="One integer: the minimum number of rooms.",
    cons=["1 <= n <= 5000", "0 <= start < end <= 1000000000"],
    solve=s_rooms,
    brute=b_rooms,
    wrong=w_rooms,
    gen=g_rooms,
    big=lambda rng: fmt(4000, *[f"{(s := rng.randint(0, 5000))} {s + rng.randint(1, 30)}" for _ in range(4000)]),
    ex=[
        ("5\n9 12\n10 11\n11 13\n12 14\n13 15\n", "2", "No minute has three sessions running at once."),
        ("3\n1 4\n2 5\n3 6\n", "3", "All three sessions are running at minute 3."),
    ],
    known=[("1\n1 2\n", "1"), ("2\n1 2\n2 3\n", "1"), ("3\n1 5\n2 3\n2 4\n", "3"), ("3\n1 2\n3 4\n5 6\n", "1"), ("2\n0 1000000000\n0 1000000000\n", "2")],
)


# ---------------------------------------------------------------- math-geometry
def s_spiral(inp):
    d = ints(inp)
    R, C = d[0], d[1]
    g = [d[2 + r * C : 2 + (r + 1) * C] for r in range(R)]
    top, bot, left, right = 0, R - 1, 0, C - 1
    out = []
    while top <= bot and left <= right:
        out += g[top][left : right + 1]
        out += [g[r][right] for r in range(top + 1, bot + 1)]
        if top < bot:
            out += g[bot][left:right][::-1]
        if left < right:
            out += [g[r][left] for r in range(bot - 1, top, -1)]
        top, bot, left, right = top + 1, bot - 1, left + 1, right - 1
    return row(out) + "\n"


def b_spiral(inp):  # walk and turn right at walls / visited cells
    d = ints(inp)
    R, C = d[0], d[1]
    g = [d[2 + r * C : 2 + (r + 1) * C] for r in range(R)]
    seen = [[False] * C for _ in range(R)]
    r = c = k = 0
    dirs = [(0, 1), (1, 0), (0, -1), (-1, 0)]
    out = []
    for _ in range(R * C):
        out.append(g[r][c])
        seen[r][c] = True
        nr, nc = r + dirs[k][0], c + dirs[k][1]
        if not (0 <= nr < R and 0 <= nc < C) or seen[nr][nc]:
            k = (k + 1) % 4
            nr, nc = r + dirs[k][0], c + dirs[k][1]
        r, c = nr, nc
    return row(out) + "\n"


def w_spiral(inp):  # four unguarded passes per ring: repeats cells on a single remaining row/column
    d = ints(inp)
    R, C = d[0], d[1]
    g = [d[2 + r * C : 2 + (r + 1) * C] for r in range(R)]
    top, bot, left, right = 0, R - 1, 0, C - 1
    out = []
    while top <= bot and left <= right:
        out += g[top][left : right + 1]
        out += [g[r][right] for r in range(top + 1, bot + 1)]
        out += g[bot][left:right][::-1]
        out += [g[r][left] for r in range(bot - 1, top, -1)]
        top, bot, left, right = top + 1, bot - 1, left + 1, right - 1
    return row(out) + "\n"


def g_spiral(rng, i):
    R, C = rng.randint(1, 5), rng.randint(1, 5)
    return fmt(f"{R} {C}", *[row([rng.randint(0, 99) for _ in range(C)]) for _ in range(R)])


add(
    id="spiral-walk",
    title="Spiral Walk",
    diff="medium",
    pat="math-geometry",
    st="A robot vacuum cleans a rectangular floor of R rows and C columns, starting at the top-left tile. It moves right along the top edge, then down the right edge, then left along the bottom edge, then up the left edge, and keeps spiralling inward in the same turning direction until every tile has been visited exactly once. Each tile shows a dust reading. Print the readings in the order the robot visits the tiles.",
    inf="Line 1: R and C. Then R lines of C integers.",
    outf="R * C integers separated by single spaces on one line.",
    cons=["1 <= R, C <= 100", "-1000000000 <= reading <= 1000000000"],
    solve=s_spiral,
    brute=b_spiral,
    wrong=w_spiral,
    gen=g_spiral,
    big=lambda rng: fmt("60 60", *[row([rng.randint(0, 9999) for _ in range(60)]) for _ in range(60)]),
    ex=[
        ("3 4\n1 2 3 4\n5 6 7 8\n9 10 11 12\n", "1 2 3 4 8 12 11 10 9 5 6 7", "Outer ring clockwise, then the middle row."),
        ("2 2\n5 6\n8 7\n", "5 6 7 8", "A single ring."),
    ],
    known=[("1 1\n7\n", "7"), ("1 4\n1 2 3 4\n", "1 2 3 4"), ("4 1\n1\n2\n3\n4\n", "1 2 3 4"), ("3 3\n1 2 3\n4 5 6\n7 8 9\n", "1 2 3 6 9 8 7 4 5"), ("2 3\n1 2 3\n4 5 6\n", "1 2 3 6 5 4")],
)


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


def b_line(inp):
    d = ints(inp)
    n = d[0]
    if n > 60:
        return None
    p = [(d[1 + 2 * i], d[2 + 2 * i]) for i in range(n)]
    best = min(n, 2)
    for i in range(n):
        for j in range(i + 1, n):
            c = sum(1 for k in range(n) if (p[j][0] - p[i][0]) * (p[k][1] - p[i][1]) == (p[j][1] - p[i][1]) * (p[k][0] - p[i][0]))
            best = max(best, c)
    return f"{best}\n"


def w_line(inp):  # slope-based but skips vertical lines
    d = ints(inp)
    n = d[0]
    pts = [(d[1 + 2 * i], d[2 + 2 * i]) for i in range(n)]
    best = 1
    for i in range(n):
        cnt = Counter()
        for j in range(i + 1, n):
            dx, dy = pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]
            if dx == 0:
                continue
            g = math.gcd(dx, dy)
            dx, dy = dx // g, dy // g
            if dx < 0:
                dx, dy = -dx, -dy
            cnt[(dx, dy)] += 1
        if cnt:
            best = max(best, max(cnt.values()) + 1)
    return f"{best}\n"


def g_line(rng, i):
    n = rng.randint(1, 7)
    cells = rng.sample(range(25), n)
    return fmt(n, *[f"{c % 5} {c // 5}" for c in cells])


add(
    id="lantern-line",
    title="Lantern Line",
    diff="hard",
    pat="math-geometry",
    st="A park has n lanterns at distinct integer coordinates on a flat plane. A string of fairy lights can be pulled perfectly straight in any direction (not only horizontally or vertically). Find the largest number of lanterns that a single straight string can touch.",
    inf="Line 1: n. Then n lines, each 'x y'.",
    outf="One integer: the maximum number of lanterns on one straight line (at least 1).",
    cons=["1 <= n <= 1500", "-1000000000 <= x, y <= 1000000000", "All points are distinct"],
    solve=s_line,
    brute=b_line,
    wrong=w_line,
    gen=g_line,
    big=lambda rng: fmt(150, *[f"{c % 30} {c // 30}" for c in rng.sample(range(900), 150)]),
    ex=[
        ("6\n1 1\n3 2\n5 3\n4 1\n2 3\n1 4\n", "4", "Points (1,4), (2,3), (3,2), (4,1) all satisfy x + y = 5."),
        ("3\n0 0\n0 1\n1 0\n", "2", "No three of these points are collinear."),
    ],
    known=[("1\n0 0\n", "1"), ("2\n0 0\n5 7\n", "2"), ("3\n1 1\n1 5\n1 9\n", "3"), ("3\n-1000000000 -1000000000\n0 0\n1000000000 1000000000\n", "3"), ("4\n0 0\n1 1\n2 3\n3 4\n", "2")],
)


# ---------------------------------------------------------------- bit-manipulation
def s_lone(inp):
    d = ints(inp)
    a = d[1 : 1 + d[0]]
    res = 0
    for b in range(64):
        s = sum((x >> b) & 1 for x in a) % 3  # Python's >> on negatives is arithmetic: bit 63 is the sign bit
        res |= s << b
    return f"{res - (1 << 64) if res >> 63 else res}\n"


def b_lone(inp):
    d = ints(inp)
    return next(f"{v}\n" for v, c in Counter(d[1 : 1 + d[0]]).items() if c == 1)


def w_lone(inp):  # XOR works for pairs, not for triples
    d = ints(inp)
    r = 0
    for x in d[1 : 1 + d[0]]:
        r ^= x
    return f"{r}\n"


def g_lone(rng, i):
    k = rng.randint(0, 3)
    vals = rng.sample(range(-8, 9), k + 1)
    a = [v for v in vals[1:] for _ in range(3)] + [vals[0]]
    rng.shuffle(a)
    return fmt(len(a), row(a))


add(
    id="lone-signal",
    title="Lone Signal",
    diff="medium",
    pat="bit-manipulation",
    st="A radio receiver logs n signal codes. Every code was transmitted exactly three times by repeating beacons, except for one rogue code that was transmitted exactly once. Find the rogue code. Codes may be negative.",
    inf="Line 1: n (always 3k + 1 for some k >= 0). Line 2: n integers.",
    outf="One integer: the code that appears exactly once.",
    cons=["1 <= n <= 5000, n % 3 == 1", "-1000000000 <= code <= 1000000000", "Exactly one code appears once; every other appears exactly three times"],
    solve=s_lone,
    brute=b_lone,
    wrong=w_lone,
    gen=g_lone,
    big=lambda rng: (lambda vs: fmt(len(vs) * 3 + 1, row(sum(([v, v, v] for v in vs), []) + [-123456789])))(rng.sample(range(0, 10**9), 1500)),
    ex=[
        ("7\n6 3 6 6 3 3 11\n", "11", "6 and 3 each appear three times; 11 appears once."),
        ("4\n-5 -5 -5 -2\n", "-2", "Negative codes work the same way."),
    ],
    known=[("1\n5\n", "5"), ("4\n2 2 2 -9\n", "-9"), ("7\n1 1 1 5 5 5 8\n", "8"), ("4\n0 0 0 1000000000\n", "1000000000")],
)


def s_xor(inp):
    d = ints(inp)
    a = d[1 : 1 + d[0]]
    best = 0
    for b in range(30, -1, -1):
        cand = best | (1 << b)
        pre = {x >> b for x in a}
        if any((p ^ (cand >> b)) in pre for p in pre):
            best = cand
    return f"{best}\n"


def b_xor(inp):
    d = ints(inp)
    a = d[1 : 1 + d[0]]
    if len(a) > 300:
        return None
    return f"{max(a[i] ^ a[j] for i in range(len(a)) for j in range(i + 1, len(a)))}\n"


def w_xor(inp):  # pairs the largest value with the smallest
    d = ints(inp)
    a = d[1 : 1 + d[0]]
    return f"{max(a) ^ min(a)}\n"


def g_xor(rng, i):
    n = rng.randint(2, 7)
    return fmt(n, row([rng.randint(0, 63) for _ in range(n)]))


add(
    id="clash-keys",
    title="Clash Keys",
    diff="hard",
    pat="bit-manipulation",
    st="A cipher machine holds n keys, each a non-negative integer. Mixing two different keys (two different positions in the list) produces the bitwise XOR of their values. Find the largest value any mixture can produce. Two keys with the same value may be mixed, which yields 0.",
    inf="Line 1: n. Line 2: n integers.",
    outf="One integer: the maximum XOR over all pairs of distinct positions.",
    cons=["2 <= n <= 5000", "0 <= key < 2^30"],
    solve=s_xor,
    brute=b_xor,
    wrong=w_xor,
    gen=g_xor,
    big=lambda rng: fmt(4000, row([rng.randint(0, 2**30 - 1) for _ in range(4000)])),
    ex=[
        ("4\n14 7 2 9\n", "14", "7 xor 9 = 14, the largest of the six mixtures."),
        ("2\n6 6\n", "0", "The only pair has equal keys."),
    ],
    known=[("2\n5 5\n", "0"), ("2\n0 1073741823\n", "1073741823"), ("3\n3 10 5\n", "15"), ("4\n1 2 4 8\n", "12")],
)
