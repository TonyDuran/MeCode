"""Batch 3: graphs, dp-1d, dp-2d, greedy (new problems)."""
import sys, heapq, bisect, math, itertools, functools  # noqa: F401,E401
from collections import *  # noqa: F401,F403
from itertools import product
from lib import add, ints, row, fmt, charging_starts, dom_charging  # noqa: F401

MOD = 1_000_000_007


# ---------------------------------------------------------------- graphs
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


def b_island(inp):  # union-find over adjacent land cells
    t = inp.split()
    R, C, g = int(t[0]), int(t[1]), t[2 : 2 + int(t[0])]
    par = {(r, c): (r, c) for r in range(R) for c in range(C) if g[r][c] == "#"}

    def find(x):
        while par[x] != x:
            par[x] = par[par[x]]
            x = par[x]
        return x

    for (r, c) in list(par):
        for nb in ((r + 1, c), (r, c + 1)):
            if nb in par:
                par[find((r, c))] = find(nb)
    sizes = Counter(find(x) for x in par)
    return f"{len(sizes)} {max(sizes.values(), default=0)}\n"


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


def g_island(rng, i):
    R, C = rng.randint(1, 5), rng.randint(1, 5)
    return fmt(f"{R} {C}", *["".join("#" if rng.random() < 0.45 else "." for _ in range(C)) for _ in range(R)])


add(
    id="reef-clusters",
    title="Reef Clusters",
    diff="easy",
    pat="graphs",
    st="A satellite map of a lagoon marks coral cells with '#' and open water with '.'. Coral cells that touch along a side (up, down, left or right) belong to the same reef; cells that touch only at a corner do not. Count the reefs and report the size of the biggest one.",
    inf="Line 1: R and C. Then R lines of C characters each, '#' for coral and '.' for water.",
    outf="Two integers separated by a space: the number of reefs and the number of cells in the largest reef (both 0 when there is no coral).",
    cons=["1 <= R, C <= 200", "Grid characters are only '#' and '.'", "R * C <= 40000"],
    solve=s_island,
    brute=b_island,
    wrong=w_island,
    gen=g_island,
    big=lambda rng: fmt("80 80", *["".join("#" if rng.random() < 0.5 else "." for _ in range(80)) for _ in range(80)]),
    ex=[
        ("4 5\n##..#\n#...#\n..#..\n....#\n", "4 3", "Reefs: the 3-cell corner group, the 2-cell right column, and two single cells."),
        ("3 4\n#.#.\n.#.#\n#.#.\n", "6 1", "Cells that only meet at corners are separate reefs."),
    ],
    known=[("1 1\n#\n", "1 1"), ("1 1\n.\n", "0 0"), ("2 2\n#.\n.#\n", "2 1"), ("3 3\n###\n#.#\n###\n", "1 8")],
)


def s_mold(inp):
    t = inp.split()
    R, C, g = int(t[0]), int(t[1]), t[2 : 2 + int(t[0])]
    dist = {}
    dq = deque()
    for r in range(R):
        for c in range(C):
            if g[r][c] == "M":
                dist[(r, c)] = 0
                dq.append((r, c))
    while dq:
        y, x = dq.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < R and 0 <= nx < C and g[ny][nx] in ".B" and (ny, nx) not in dist:
                dist[(ny, nx)] = dist[(y, x)] + 1
                dq.append((ny, nx))
    best = 0
    for r in range(R):
        for c in range(C):
            if g[r][c] == "B":
                if (r, c) not in dist:
                    return "-1\n"
                best = max(best, dist[(r, c)])
    return f"{best}\n"


def b_mold(inp):  # minute-by-minute simulation
    t = inp.split()
    R, C, g = int(t[0]), int(t[1]), [list(x) for x in t[2 : 2 + int(t[0])]]
    minute = 0
    while True:
        if not any("B" in row_ for row_ in g):
            return f"{minute}\n"
        new = [r[:] for r in g]
        for r in range(R):
            for c in range(C):
                if g[r][c] == "M":
                    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        ny, nx = r + dy, c + dx
                        if 0 <= ny < R and 0 <= nx < C and g[ny][nx] in ".B":
                            new[ny][nx] = "M"
        if new == g:
            return "-1\n"
        g = new
        minute += 1


def w_mold(inp):  # only the first mold source spreads
    t = inp.split()
    R, C, g = int(t[0]), int(t[1]), t[2 : 2 + int(t[0])]
    first = next(((r, c) for r in range(R) for c in range(C) if g[r][c] == "M"), None)
    if first is None:
        return "-1\n" if any("B" in x for x in g) else "0\n"
    grid = ["".join("." if (ch == "M" and (r, c) != first) else ch for c, ch in enumerate(line)) for r, line in enumerate(g)]
    return s_mold(f"{R} {C}\n" + "\n".join(grid) + "\n")


def g_mold(rng, i):
    R, C = rng.randint(1, 4), rng.randint(1, 5)
    return fmt(f"{R} {C}", *["".join(rng.choice("..MB#") for _ in range(C)) for _ in range(R)])


add(
    id="bread-mold",
    title="Bread Mold",
    diff="medium",
    pat="graphs",
    st="A pantry shelf is a grid. 'M' marks a moldy crumb, 'B' a slice of bread, '.' an empty shelf tile and '#' a wall. Every minute, each tile with mold infects all tiles directly above, below, left and right of it that are empty or hold bread (walls block it). Report the number of minutes until every slice of bread is moldy, or -1 if some slice can never be reached. With no bread on the shelf the answer is 0.",
    inf="Line 1: R and C. Then R lines of C characters from M . B #.",
    outf="One integer: the minutes until the last slice of bread is moldy, 0 if there is no bread, or -1 if impossible.",
    cons=["1 <= R, C <= 200", "R * C <= 40000", "Grid characters are only M . B #"],
    solve=s_mold,
    brute=b_mold,
    wrong=w_mold,
    gen=g_mold,
    big=lambda rng: fmt("60 60", *["M" + "".join(rng.choice("...B") for _ in range(58)) + "M" for _ in range(60)]),
    ex=[
        ("3 4\nM..B\n.#..\nB..M\n", "2", "Both slices are two steps from the nearest mold source."),
        ("2 3\nMB#\n#.B\n", "3", "Mold goes (0,0) -> (0,1) -> (1,1) -> (1,2); the walls force the detour."),
    ],
    known=[("1 1\nB\n", "-1"), ("1 1\nM\n", "0"), ("1 5\nM.B.B\n", "4"), ("1 4\nMB#B\n", "-1"), ("1 6\nMBBBBM\n", "2")],
)


def s_rival(inp):
    d = ints(inp)
    n, m = d[0], d[1]
    adj = [[] for _ in range(n + 1)]
    for i in range(m):
        u, v = d[2 + 2 * i], d[3 + 2 * i]
        adj[u].append(v)
        adj[v].append(u)
    col = [0] * (n + 1)
    for s in range(1, n + 1):
        if col[s]:
            continue
        col[s] = 1
        dq = deque([s])
        while dq:
            u = dq.popleft()
            for v in adj[u]:
                if not col[v]:
                    col[v] = 3 - col[u]
                    dq.append(v)
                elif col[v] == col[u]:
                    return "NO\n"
    return "YES\n"


def b_rival(inp):
    d = ints(inp)
    n, m = d[0], d[1]
    if n > 10:
        return None
    E = [(d[2 + 2 * i], d[3 + 2 * i]) for i in range(m)]
    for mask in range(1 << n):
        if all((mask >> (u - 1) & 1) != (mask >> (v - 1) & 1) for u, v in E):
            return "YES\n"
    return "NO\n"


def w_rival(inp):  # only looks for triangles
    d = ints(inp)
    n, m = d[0], d[1]
    E = {frozenset((d[2 + 2 * i], d[3 + 2 * i])) for i in range(m)}
    for a in range(1, n + 1):
        for b in range(a + 1, n + 1):
            for c in range(b + 1, n + 1):
                if {frozenset((a, b)), frozenset((b, c)), frozenset((a, c))} <= E:
                    return "NO\n"
    return "YES\n"


def g_rival(rng, i):
    n = rng.randint(2, 8)
    m = rng.randint(0, 9)
    es = []
    for _ in range(m):
        u, v = rng.sample(range(1, n + 1), 2)
        es.append(f"{u} {v}")
    return fmt(f"{n} {m}", *es)


add(
    id="rival-teams",
    title="Rival Teams",
    diff="medium",
    pat="graphs",
    st="A school with n students (numbered from 1) lists m pairs of rivals. The coach wants to split everyone into two teams so that no two rivals end up on the same team. Decide whether such a split exists. Students with no rivals can join either team, and the same pair may be listed more than once.",
    inf="Line 1: n and m. Then m lines, each with two different student numbers u v.",
    outf="YES if the split is possible, otherwise NO.",
    cons=["1 <= n <= 5000", "0 <= m <= 8000", "1 <= u, v <= n and u != v"],
    solve=s_rival,
    brute=b_rival,
    wrong=w_rival,
    gen=g_rival,
    big=lambda rng: fmt("4000 3999", *[f"{i} {i + 1}" for i in range(1, 4000)]),
    ex=[
        ("6 5\n1 2\n2 3\n3 4\n4 5\n5 6\n", "YES", "Alternate students along the chain: odds on one team, evens on the other."),
        ("4 4\n1 2\n2 3\n3 1\n3 4\n", "NO", "Students 1, 2, 3 are mutual rivals, so two of them must share a team."),
    ],
    known=[("3 0\n", "YES"), ("3 3\n1 2\n2 3\n3 1\n", "NO"), ("5 5\n1 2\n2 3\n3 4\n4 5\n5 1\n", "NO"), ("4 4\n1 2\n2 3\n3 4\n4 1\n", "YES")],
)


# ---------------------------------------------------------------- dp-1d
def s_hops(inp):
    d = ints(inp)
    n, h, hops = d[0], d[1], d[2 : 2 + d[1]]
    dp = [0] * (n + 1)
    dp[0] = 1
    for i in range(1, n + 1):
        dp[i] = sum(dp[i - x] for x in hops if x <= i) % 1000000007
    return f"{dp[n]}\n"


def b_hops(inp):
    d = ints(inp)
    n, h, hops = d[0], d[1], d[2 : 2 + d[1]]
    if n > 14:
        return None

    def go(rem):
        return 1 if rem == 0 else sum(go(rem - x) for x in hops if x <= rem)

    return f"{go(n) % 1000000007}\n"


def w_hops(inp):  # counts unordered multisets of hops
    d = ints(inp)
    n, h, hops = d[0], d[1], d[2 : 2 + d[1]]
    dp = [0] * (n + 1)
    dp[0] = 1
    for x in hops:
        for i in range(x, n + 1):
            dp[i] = (dp[i] + dp[i - x]) % 1000000007
    return f"{dp[n]}\n"


def g_hops(rng, i):
    h = rng.randint(1, 3)
    return fmt(f"{rng.randint(1, 12)} {h}", row(sorted(rng.sample(range(1, 6), h))))


add(
    id="stepping-hops",
    title="Stepping Hops",
    diff="easy",
    pat="dp-1d",
    st="A frog starts on stone 0 of a long row of stones and wants to land exactly on stone n. In one hop it may move forward by any of h allowed distances. Two ways are different when the sequence of hop lengths differs (hopping 1 then 2 is not the same as 2 then 1). Count the ways modulo 1000000007.",
    inf="Line 1: n and h. Line 2: h distinct positive integers (the allowed hop lengths).",
    outf="One integer: the number of hop sequences landing exactly on stone n, modulo 1000000007.",
    cons=["1 <= n <= 100000", "1 <= h <= 10", "1 <= hop length <= 1000, all distinct"],
    solve=s_hops,
    brute=b_hops,
    wrong=w_hops,
    gen=g_hops,
    big=lambda rng: fmt("100000 5", "1 2 3 7 50"),
    ex=[
        ("4 2\n1 2\n", "5", "1111, 112, 121, 211, 22."),
        ("5 2\n2 3\n", "2", "2+3 and 3+2 are different sequences."),
    ],
    known=[("1 1\n1\n", "1"), ("3 1\n2\n", "0"), ("5 3\n1 2 3\n", "13"), ("4 2\n2 4\n", "2")],
)


def s_lantern_fest(inp):
    d = ints(inp)
    a = d[1 : 1 + d[0]]
    take = skip = 0
    for x in a:
        take, skip = skip + x, max(skip, take)
    return f"{max(take, skip, 0)}\n"


def b_lantern_fest(inp):
    d = ints(inp)
    n, a = d[0], d[1 : 1 + d[0]]
    if n > 14:
        return None
    return f"{max(sum(a[i] for i in range(n) if m >> i & 1) for m in range(1 << n) if not m & (m >> 1))}\n"


def w_lantern_fest(inp):  # best of the two alternating patterns
    d = ints(inp)
    a = d[1 : 1 + d[0]]
    return f"{max(0, sum(a[0::2]), sum(a[1::2]))}\n"


def g_lantern_fest(rng, i):
    n = rng.randint(1, 9)
    return fmt(n, row([rng.randint(-3, 9) for _ in range(n)]))


add(
    id="lantern-festival",
    title="Lantern Festival",
    diff="medium",
    pat="dp-1d",
    st="Along a canal stand n lantern stalls in a row. Stall i would earn the town value[i] units of goodwill if the council lights its lantern (a value can be negative if the stall is in a bad mood). Two neighbouring stalls cannot both be lit because the glare would scare the ducks. The council may light any set of non-adjacent stalls, including none. Find the largest total goodwill.",
    inf="Line 1: n. Line 2: n integers.",
    outf="One integer: the maximum total goodwill (0 if lighting nothing is best).",
    cons=["1 <= n <= 20000", "-1000000 <= value <= 1000000"],
    solve=s_lantern_fest,
    brute=b_lantern_fest,
    wrong=w_lantern_fest,
    gen=g_lantern_fest,
    big=lambda rng: fmt(9000, row([rng.randint(-1000, 1000) for _ in range(9000)])),
    ex=[
        ("5\n4 10 3 3 8\n", "18", "Light stalls 2 and 5 (10 + 8)."),
        ("3\n-2 -3 -1\n", "0", "Every stall is negative, so light nothing."),
    ],
    known=[("1\n-5\n", "0"), ("3\n5 1 5\n", "10"), ("5\n9 1 1 9 1\n", "18"), ("3\n2 -1 2\n", "4")],
)


def s_coins(inp):
    d = ints(inp)
    k, amt, coins = d[0], d[1], d[2 : 2 + d[0]]
    INF = 10**9
    dp = [0] + [INF] * amt
    for a in range(1, amt + 1):
        for c in coins:
            if c <= a and dp[a - c] + 1 < dp[a]:
                dp[a] = dp[a - c] + 1
    return f"{dp[amt] if dp[amt] < INF else -1}\n"


def b_coins(inp):  # BFS over remaining amounts
    d = ints(inp)
    k, amt, coins = d[0], d[1], d[2 : 2 + d[0]]
    if amt > 400:
        return None
    seen, level, steps = {amt}, [amt], 0
    while level:
        if 0 in level:
            return f"{steps}\n"
        nxt = []
        for v in level:
            for c in coins:
                if v - c >= 0 and v - c not in seen:
                    seen.add(v - c)
                    nxt.append(v - c)
        level, steps = nxt, steps + 1
    return "-1\n"


def w_coins(inp):  # greedy largest coin first
    d = ints(inp)
    k, amt, coins = d[0], d[1], sorted(d[2 : 2 + d[0]], reverse=True)
    n = 0
    for c in coins:
        n += amt // c
        amt %= c
    return f"{n if amt == 0 else -1}\n"


def g_coins(rng, i):
    k = rng.randint(1, 3)
    return fmt(f"{k} {rng.randint(0, 20)}", row(rng.sample(range(1, 9), k)))


add(
    id="vending-change",
    title="Vending Change",
    diff="medium",
    pat="dp-1d",
    st="A vending machine holds an unlimited supply of k coin types. Given an amount owed, find the fewest coins that add up to it exactly. If the amount cannot be formed, report -1. An amount of 0 needs 0 coins.",
    inf="Line 1: k and the amount. Line 2: k distinct positive integers (coin values).",
    outf="One integer: the minimum number of coins, or -1 if impossible.",
    cons=["1 <= k <= 12", "0 <= amount <= 20000", "1 <= coin value <= 20000, all distinct"],
    solve=s_coins,
    brute=b_coins,
    wrong=w_coins,
    gen=g_coins,
    big=lambda rng: fmt("6 19999", row(rng.sample(range(7, 400), 6))),
    ex=[
        ("3 10\n1 5 6\n", "2", "5 + 5; taking the biggest coin first (6 + 1+1+1+1) would use 5 coins."),
        ("2 7\n2 4\n", "-1", "Only even amounts can be built."),
    ],
    known=[("1 3\n2\n", "-1"), ("3 6\n1 3 4\n", "2"), ("2 0\n1 5\n", "0"), ("3 11\n1 2 5\n", "3")],
)


# ---------------------------------------------------------------- dp-2d
def s_routes(inp):
    t = inp.split()
    R, C, g = int(t[0]), int(t[1]), t[2 : 2 + int(t[0])]
    dp = [[0] * C for _ in range(R)]
    for r in range(R):
        for c in range(C):
            if g[r][c] == "#":
                continue
            if r == 0 and c == 0:
                dp[r][c] = 1
            else:
                dp[r][c] = ((dp[r - 1][c] if r else 0) + (dp[r][c - 1] if c else 0)) % 1000000007
    return f"{dp[R - 1][C - 1]}\n"


def b_routes(inp):
    t = inp.split()
    R, C, g = int(t[0]), int(t[1]), t[2 : 2 + int(t[0])]
    if R * C > 30:
        return None

    def go(r, c):
        if r >= R or c >= C or g[r][c] == "#":
            return 0
        if r == R - 1 and c == C - 1:
            return 1
        return go(r + 1, c) + go(r, c + 1)

    return f"{go(0, 0) % 1000000007}\n"


def w_routes(inp):  # ignores the blocked tiles
    t = inp.split()
    R, C = int(t[0]), int(t[1])
    return f"{math.comb(R + C - 2, R - 1) % 1000000007}\n"


def g_routes(rng, i):
    R, C = rng.randint(1, 5), rng.randint(1, 5)
    return fmt(f"{R} {C}", *["".join("#" if rng.random() < 0.2 else "." for _ in range(C)) for _ in range(R)])


add(
    id="garden-routes",
    title="Garden Routes",
    diff="medium",
    pat="dp-2d",
    st="A gardener walks from the top-left tile to the bottom-right tile of a rectangular garden. Each step moves one tile right or one tile down. Tiles marked '#' are flowerbeds that cannot be entered, tiles marked '.' are walkable. Count the different walks, modulo 1000000007. If the start or the destination is a flowerbed, the answer is 0.",
    inf="Line 1: R and C. Then R lines of C characters, '.' or '#'.",
    outf="One integer: the number of walks modulo 1000000007.",
    cons=["1 <= R, C <= 200", "R * C <= 40000"],
    solve=s_routes,
    brute=b_routes,
    wrong=w_routes,
    gen=g_routes,
    big=lambda rng: fmt("100 100", *["".join("#" if rng.random() < 0.08 and (r, c) not in ((0, 0), (99, 99)) else "." for c in range(100)) for r in range(100)]),
    ex=[
        ("3 4\n....\n.#..\n....\n", "4", "10 walks on an open 3x4 garden, minus the 6 that cross the flowerbed."),
        ("2 3\n.#.\n...\n", "1", "The flowerbed forces down first, then right twice."),
    ],
    known=[("1 1\n.\n", "1"), ("1 1\n#\n", "0"), ("2 2\n..\n..\n", "2"), ("2 2\n.#\n#.\n", "0"), ("3 3\n...\n.#.\n...\n", "2")],
)


def s_spell(inp):
    a, b = inp.split()[:2]
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return f"{prev[-1]}\n"


def b_spell(inp):
    a, b = inp.split()[:2]
    if len(a) + len(b) > 12:
        return None

    @functools.lru_cache(None)
    def go(i, j):
        if i == len(a):
            return len(b) - j
        if j == len(b):
            return len(a) - i
        if a[i] == b[j]:
            return go(i + 1, j + 1)
        return 1 + min(go(i + 1, j), go(i, j + 1), go(i + 1, j + 1))

    return f"{go(0, 0)}\n"


def w_spell(inp):  # position-by-position mismatches plus the length difference
    a, b = inp.split()[:2]
    return f"{sum(x != y for x, y in zip(a, b)) + abs(len(a) - len(b))}\n"


def g_spell(rng, i):
    return "".join(rng.choice("abc") for _ in range(rng.randint(1, 6))) + "\n" + "".join(rng.choice("abc") for _ in range(rng.randint(1, 6))) + "\n"


add(
    id="spell-fixer",
    title="Spell Fixer",
    diff="medium",
    pat="dp-2d",
    st="A text editor corrects a typed word into a target word using single-letter edits: insert one letter anywhere, delete one letter, or replace one letter with another. Find the smallest number of edits that turns the typed word into the target.",
    inf="Line 1: the typed word. Line 2: the target word. Both are non-empty lowercase strings.",
    outf="One integer: the minimum number of edits.",
    cons=["1 <= length of each word <= 1000", "Only lowercase letters a-z"],
    solve=s_spell,
    brute=b_spell,
    wrong=w_spell,
    gen=g_spell,
    big=lambda rng: "".join(rng.choice("abcd") for _ in range(900)) + "\n" + "".join(rng.choice("abcd") for _ in range(900)) + "\n",
    ex=[
        ("planet\nplanter\n", "2", "Insert t after plan, then replace the final t with r (planet -> plantet -> planter)."),
        ("flaw\nlawn\n", "2", "Delete f, then insert n."),
    ],
    known=[("a\na\n", "0"), ("abc\nbcd\n", "2"), ("kitten\nsitting\n", "3"), ("a\nbbbb\n", "4"), ("abcdef\nabcdef\n", "0")],
)


def s_pack(inp):
    d = ints(inp)
    n, W = d[0], d[1]
    dp = [0] * (W + 1)
    for i in range(n):
        w, v = d[2 + 2 * i], d[3 + 2 * i]
        for c in range(W, w - 1, -1):
            dp[c] = max(dp[c], dp[c - w] + v)
    return f"{dp[W]}\n"


def b_pack(inp):
    d = ints(inp)
    n, W = d[0], d[1]
    if n > 12:
        return None
    it = [(d[2 + 2 * i], d[3 + 2 * i]) for i in range(n)]
    best = 0
    for m in range(1 << n):
        w = sum(it[i][0] for i in range(n) if m >> i & 1)
        if w <= W:
            best = max(best, sum(it[i][1] for i in range(n) if m >> i & 1))
    return f"{best}\n"


def w_pack(inp):  # greedy by value density
    d = ints(inp)
    n, W = d[0], d[1]
    it = sorted(((d[2 + 2 * i], d[3 + 2 * i]) for i in range(n)), key=lambda x: -x[1] / x[0])
    tot = 0
    for w, v in it:
        if w <= W:
            W -= w
            tot += v
    return f"{tot}\n"


def g_pack(rng, i):
    n = rng.randint(1, 7)
    return fmt(f"{n} {rng.randint(0, 12)}", *[f"{rng.randint(1, 7)} {rng.randint(1, 20)}" for _ in range(n)])


add(
    id="backpack-haul",
    title="Backpack Haul",
    diff="medium",
    pat="dp-2d",
    st="A hiker can carry at most W kilograms. There are n distinct items, each with its own weight and trail value; every item can be taken once or left behind. Choose items whose combined weight does not exceed W so that the combined value is as large as possible.",
    inf="Line 1: n and W. Then n lines, each 'weight value'.",
    outf="One integer: the maximum total value.",
    cons=["1 <= n <= 200", "0 <= W <= 5000", "1 <= weight <= 5000", "1 <= value <= 1000000"],
    solve=s_pack,
    brute=b_pack,
    wrong=w_pack,
    gen=g_pack,
    big=lambda rng: fmt("60 2000", *[f"{rng.randint(1, 400)} {rng.randint(1, 500)}" for _ in range(60)]),
    ex=[
        ("4 8\n3 30\n4 50\n5 60\n2 14\n", "90", "Take the weight-3 and weight-5 items: 30 + 60."),
        ("3 0\n1 5\n2 6\n3 7\n", "0", "Nothing fits when the capacity is 0."),
    ],
    known=[("1 5\n6 10\n", "0"), ("1 5\n5 10\n", "10"), ("3 50\n10 60\n20 100\n30 120\n", "220"), ("2 3\n1 1\n1 1\n", "2")],
)


# ---------------------------------------------------------------- greedy
def s_stones(inp):
    d = ints(inp)
    n, a = d[0], d[1 : 1 + d[0]]
    far = 0
    for i in range(n):
        if i > far:
            return "NO\n"
        far = max(far, i + a[i])
    return "YES\n"


def b_stones(inp):
    d = ints(inp)
    n, a = d[0], d[1 : 1 + d[0]]
    seen, dq = {0}, deque([0])
    while dq:
        i = dq.popleft()
        for j in range(i + 1, min(n - 1, i + a[i]) + 1):
            if j not in seen:
                seen.add(j)
                dq.append(j)
    return "YES\n" if n - 1 in seen else "NO\n"


def w_stones(inp):  # only compares total jump power with the distance
    d = ints(inp)
    n, a = d[0], d[1 : 1 + d[0]]
    return "YES\n" if sum(a[:-1]) >= n - 1 else "NO\n"


def g_stones(rng, i):
    n = rng.randint(1, 8)
    return fmt(n, row([rng.randint(0, 3) for _ in range(n)]))


add(
    id="stepping-stones",
    title="Stepping Stones",
    diff="easy",
    pat="greedy",
    st="A river has n stepping stones in a line. Standing on stone i, a hiker may jump forward to any stone at most a[i] positions ahead (a[i] can be 0, which strands them). The hiker starts on stone 0. Can they reach the last stone?",
    inf="Line 1: n. Line 2: n non-negative integers a[0..n-1].",
    outf="YES if the last stone is reachable, otherwise NO.",
    cons=["1 <= n <= 20000", "0 <= a[i] <= 100000"],
    solve=s_stones,
    brute=b_stones,
    wrong=w_stones,
    gen=g_stones,
    big=lambda rng: fmt(9000, row([rng.choice([0, 1, 1, 2, 5]) for _ in range(9000)])),
    ex=[
        ("6\n2 1 0 2 1 0\n", "NO", "Stones 0..2 are reachable but stone 2 has power 0 and the others cannot jump past it."),
        ("5\n1 2 0 1 0\n", "YES", "Jump 0 -> 1 -> 3 -> 4."),
    ],
    known=[("1\n0\n", "YES"), ("4\n1 0 5 0\n", "NO"), ("5\n2 3 1 1 4\n", "YES"), ("5\n3 2 1 0 4\n", "NO")],
)


def s_charge(inp):
    d = ints(inp)
    n, gain, cost = d[0], d[1 : 1 + d[0]], d[1 + d[0] : 1 + 2 * d[0]]
    if sum(gain) < sum(cost):
        return "-1\n"
    start = tank = 0
    for i in range(n):
        tank += gain[i] - cost[i]
        if tank < 0:
            start, tank = i + 1, 0
    return f"{start}\n"


def b_charge(inp):
    d = ints(inp)
    n, gain, cost = d[0], d[1 : 1 + d[0]], d[1 + d[0] : 1 + 2 * d[0]]
    for s in range(n):
        tank = 0
        for k in range(n):
            i = (s + k) % n
            tank += gain[i] - cost[i]
            if tank < 0:
                break
        else:
            return f"{s}\n"
    return "-1\n"


def w_charge(inp):  # first station whose own charge covers its own leg
    d = ints(inp)
    n, gain, cost = d[0], d[1 : 1 + d[0]], d[1 + d[0] : 1 + 2 * d[0]]
    return f"{next((i for i in range(n) if gain[i] >= cost[i]), -1)}\n"


def g_charge(rng, i):
    # The published contract says a valid start is unique, so redraw (bounded) any input with two or more valid starts.
    for _ in range(500):
        n = rng.randint(1, 6)
        s = fmt(n, row([rng.randint(0, 6) for _ in range(n)]), row([rng.randint(0, 6) for _ in range(n)]))
        if len(charging_starts(s)) <= 1:
            return s
    raise RuntimeError("charging-loop generator could not draw a unique-start input")


add(
    id="charging-loop",
    title="Charging Loop",
    diff="medium",
    pat="greedy",
    st="An electric shuttle drives around a circular route with n charging stops. Stop i hands the shuttle gain[i] units of charge, and driving from stop i to the next stop (stop n-1 wraps to stop 0) uses cost[i] units. The shuttle starts with an empty battery at some stop, collects that stop's charge, drives on, and must never run out of charge before reaching the next stop. Find the stop where it must start to complete one full loop; if no start works, report -1. (Whenever a valid start exists, it is unique.)",
    inf="Line 1: n. Line 2: n integers gain[i]. Line 3: n integers cost[i].",
    outf="One integer: the 0-based index of the starting stop, or -1.",
    cons=["1 <= n <= 20000", "0 <= gain[i], cost[i] <= 1000000"],
    solve=s_charge,
    brute=b_charge,
    wrong=w_charge,
    gen=g_charge,
    dom=dom_charging,
    big=lambda rng: fmt(9000, row([rng.randint(0, 9) for _ in range(8999)] + [9]), row([8] * 9000)),
    ex=[
        ("3\n2 3 4\n3 4 3\n", "-1", "Total charge 9 is less than total cost 10."),
        ("4\n5 1 2 6\n4 3 4 2\n", "3", "Start at stop 3: battery 4, then 5, 3, 1 -- never negative."),
    ],
    known=[("1\n5\n5\n", "0"), ("1\n4\n5\n", "-1"), ("3\n1 2 3\n2 3 1\n", "2"), ("5\n1 2 3 4 5\n3 4 5 1 2\n", "3")],
)


def s_ladder(inp):
    d = ints(inp)
    r = d[1 : 1 + d[0]]
    n = d[0]
    c = [1] * n
    for i in range(1, n):
        if r[i] > r[i - 1]:
            c[i] = c[i - 1] + 1
    for i in range(n - 2, -1, -1):
        if r[i] > r[i + 1]:
            c[i] = max(c[i], c[i + 1] + 1)
    return f"{sum(c)}\n"


def b_ladder(inp):
    d = ints(inp)
    n, r = d[0], d[1 : 1 + d[0]]
    if n > 6:
        return None
    best = None
    for c in product(range(1, n + 1), repeat=n):
        if all((r[i] <= r[i + 1] or c[i] > c[i + 1]) and (r[i] >= r[i + 1] or c[i] < c[i + 1]) for i in range(n - 1)):
            best = sum(c) if best is None else min(best, sum(c))
    return f"{best}\n"


def w_ladder(inp):  # left-to-right pass only
    d = ints(inp)
    n, r = d[0], d[1 : 1 + d[0]]
    c = [1] * n
    for i in range(1, n):
        if r[i] > r[i - 1]:
            c[i] = c[i - 1] + 1
    return f"{sum(c)}\n"


def g_ladder(rng, i):
    n = rng.randint(1, 6)
    return fmt(n, row([rng.randint(1, 5) for _ in range(n)]))


add(
    id="reward-ladder",
    title="Reward Ladder",
    diff="hard",
    pat="greedy",
    st="A teacher stands n students in a line and hands out stickers. Every student receives at least one sticker, and any student whose test score is strictly higher than that of an immediate neighbour (left or right) must receive strictly more stickers than that neighbour. Equal scores impose no constraint. Find the smallest total number of stickers.",
    inf="Line 1: n. Line 2: n integers (test scores in line order).",
    outf="One integer: the minimum total number of stickers.",
    cons=["1 <= n <= 20000", "0 <= score <= 1000000000"],
    solve=s_ladder,
    brute=b_ladder,
    wrong=w_ladder,
    gen=g_ladder,
    big=lambda rng: fmt(9000, row([rng.randint(0, 1000) for _ in range(9000)])),
    ex=[
        ("5\n1 3 4 5 2\n", "11", "Stickers 1,2,3,4,1."),
        ("3\n2 2 2\n", "3", "Equal scores need no extra stickers."),
    ],
    known=[("1\n5\n", "1"), ("3\n1 0 2\n", "5"), ("3\n1 2 2\n", "4"), ("4\n1 2 3 4\n", "10"), ("4\n4 3 2 1\n", "10")],
)
