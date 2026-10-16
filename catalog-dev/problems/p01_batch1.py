"""Batch 1: arrays-hashing, sliding-window, stack, two-pointers (new problems)."""
import sys, heapq, bisect, math, itertools, functools  # noqa: F401,E401
from collections import *  # noqa: F401,F403
from lib import add, ints, row, fmt  # noqa: F401


# ---------------------------------------------------------------- arrays-hashing
def s_shelf(inp):
    t = inp.split()
    n = int(t[0])
    c = Counter("".join(sorted(w)) for w in t[1 : 1 + n])
    return f"{len(c)} {max(c.values())}\n"


def b_shelf(inp):
    t = inp.split()
    n = int(t[0])
    if n > 60:
        return None
    ws = t[1 : 1 + n]
    groups = []
    for w in ws:
        for g in groups:
            if Counter(g[0]) == Counter(w):
                g.append(w)
                break
        else:
            groups.append([w])
    return f"{len(groups)} {max(map(len, groups))}\n"


def w_shelf(inp):  # keys on the SET of letters, ignoring how many times each appears
    t = inp.split()
    n = int(t[0])
    c = Counter("".join(sorted(set(w))) for w in t[1 : 1 + n])
    return f"{len(c)} {max(c.values())}\n"


def g_shelf(rng, i):
    n = rng.randint(1, 9)
    return fmt(n, *["".join(rng.choice("ab" if i % 2 else "abc") for _ in range(rng.randint(1, 4))) for _ in range(n)])


add(
    id="shelf-signatures",
    title="Shelf Signatures",
    diff="easy",
    pat="arrays-hashing",
    st="A bookshop labels each shelf with a word. Two labels are shelf-mates when one can be rearranged into the other using every letter exactly once. Group all labels into maximal sets of shelf-mates (an identical label that appears twice counts as two members of its set). Report how many sets exist and how many members the largest set has.",
    inf="Line 1: n. Then n lines, each holding one lowercase word.",
    outf="Two integers separated by a space: the number of sets, then the size of the largest set.",
    cons=["1 <= n <= 5000", "Each word has 1 to 20 lowercase letters a-z", "The whole input is at most 64 KiB"],
    solve=s_shelf,
    brute=b_shelf,
    wrong=w_shelf,
    gen=g_shelf,
    big=lambda rng: fmt(4000, *["".join(rng.choice("abc") for _ in range(rng.randint(1, 8))) for _ in range(4000)]),
    ex=[
        ("5\nlisten\nsilent\nenlist\ngoogle\ngogole\n", "2 3", "listen, silent and enlist share letters; google and gogole share letters."),
        ("4\nabc\nabd\nabc\ncab\n", "2 3", "abc appears twice and cab is a rearrangement, so that set has 3 members; abd is alone."),
    ],
    known=[("3\nab\nba\nab\n", "1 3"), ("2\naab\nabb\n", "2 1"), ("1\nz\n", "1 1"), ("4\naa\naa\na\naaa\n", "3 2")],
)


def s_ledger(inp):
    d = ints(inp)
    n, k = d[0], d[1]
    seen = Counter({0: 1})
    p = r = 0
    for x in d[2 : 2 + n]:
        p += x
        r += seen[p - k]
        seen[p] += 1
    return f"{r}\n"


def b_ledger(inp):
    d = ints(inp)
    n, k = d[0], d[1]
    if n > 300:
        return None
    a = d[2 : 2 + n]
    return f"{sum(1 for i in range(n) for j in range(i, n) if sum(a[i : j + 1]) == k)}\n"


def w_ledger(inp):  # two-pointer window: only valid if every entry were positive
    d = ints(inp)
    n, k = d[0], d[1]
    a = d[2 : 2 + n]
    r = lo = s = 0
    for hi in range(n):
        s += a[hi]
        while s > k and lo <= hi:
            s -= a[lo]
            lo += 1
        if s == k:
            r += 1
    return f"{r}\n"


def g_ledger(rng, i):
    n = rng.randint(1, 8)
    return fmt(f"{n} {rng.randint(-3, 3)}", row([rng.randint(-3, 3) for _ in range(n)]))


add(
    id="ledger-windows",
    title="Ledger Windows",
    diff="medium",
    pat="arrays-hashing",
    st="A ledger lists n signed adjustments in the order they were posted. An audit window is a non-empty run of consecutive entries. Count the audit windows whose entries add up to exactly k.",
    inf="Line 1: n and k separated by a space. Line 2: n integers separated by spaces.",
    outf="One integer: the number of audit windows with total exactly k.",
    cons=["1 <= n <= 20000", "-1000000000 <= entry, k <= 1000000000", "The answer fits in a signed 64-bit integer"],
    solve=s_ledger,
    brute=b_ledger,
    wrong=w_ledger,
    gen=g_ledger,
    big=lambda rng: fmt("9000 0", row([rng.randint(-2, 2) for _ in range(9000)])),
    ex=[
        ("5 7\n3 4 7 -7 7\n", "5", "Windows [3,4], [7], [3,4,7,-7], [7,-7,7] and the last [7] all total 7."),
        ("4 0\n1 -1 1 -1\n", "4", "Windows [1,-1], [-1,1], [1,-1] and the whole ledger total 0."),
    ],
    known=[("3 0\n0 0 0\n", "6"), ("4 3\n1 2 -1 1\n", "2"), ("1 5\n5\n", "1"), ("1 5\n4\n", "0")],
)


# ---------------------------------------------------------------- sliding-window
def s_calm(inp):
    d = ints(inp)
    n, lim, a = d[0], d[1], d[2 : 2 + d[0]]
    mx, mn = deque(), deque()
    lo = best = 0
    for hi in range(n):
        while mx and a[mx[-1]] <= a[hi]:
            mx.pop()
        mx.append(hi)
        while mn and a[mn[-1]] >= a[hi]:
            mn.pop()
        mn.append(hi)
        while a[mx[0]] - a[mn[0]] > lim:
            lo += 1
            if mx[0] < lo:
                mx.popleft()
            if mn[0] < lo:
                mn.popleft()
        best = max(best, hi - lo + 1)
    return f"{best}\n"


def b_calm(inp):
    d = ints(inp)
    n, lim, a = d[0], d[1], d[2 : 2 + d[0]]
    if n > 200:
        return None
    return f"{max(j - i for i in range(n) for j in range(i + 1, n + 1) if max(a[i:j]) - min(a[i:j]) <= lim)}\n"


def w_calm(inp):  # only compares neighbours
    d = ints(inp)
    n, lim, a = d[0], d[1], d[2 : 2 + d[0]]
    best = cur = 1
    for i in range(1, n):
        cur = cur + 1 if abs(a[i] - a[i - 1]) <= lim else 1
        best = max(best, cur)
    return f"{best}\n"


def g_calm(rng, i):
    n = rng.randint(1, 10)
    return fmt(f"{n} {rng.randint(0, 4)}", row([rng.randint(0, 9) for _ in range(n)]))


add(
    id="calm-stretch",
    title="Calm Stretch",
    diff="medium",
    pat="sliding-window",
    st="A weather station records n integer pressure readings. A stretch of consecutive readings is calm when its highest and lowest reading differ by at most d. Find the length of the longest calm stretch.",
    inf="Line 1: n and d separated by a space. Line 2: n integers separated by spaces.",
    outf="One integer: the length of the longest calm stretch.",
    cons=["1 <= n <= 20000", "0 <= d <= 2000000000", "-1000000000 <= reading <= 1000000000"],
    solve=s_calm,
    brute=b_calm,
    wrong=w_calm,
    gen=g_calm,
    big=lambda rng: fmt("9000 5", row([rng.randint(0, 20) for _ in range(9000)])),
    ex=[
        ("6 3\n4 6 5 9 10 8\n", "3", "[4,6,5] spans 2 and [9,10,8] spans 2; no stretch of 4 stays within 3."),
        ("5 0\n2 2 2 3 3\n", "3", "With d = 0 only equal readings are calm: 2 2 2."),
    ],
    known=[("1 0\n5\n", "1"), ("4 0\n1 1 2 2\n", "2"), ("5 2\n1 3 5 7 9\n", "2"), ("4 1000000000\n-1000000000 0 1000000000 5\n", "3")],
)


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


def b_flavor(inp):
    t = inp.split()
    k, s = int(t[0]), t[1]
    if len(s) > 200:
        return None
    return f"{max(j - i for i in range(len(s)) for j in range(i + 1, len(s) + 1) if len(set(s[i:j])) <= k)}\n"


def w_flavor(inp):  # demands EXACTLY k distinct letters
    t = inp.split()
    k, s = int(t[0]), t[1]
    best = 0
    for i in range(len(s)):
        for j in range(i + 1, len(s) + 1):
            if len(set(s[i:j])) == k:
                best = max(best, j - i)
    return f"{best}\n"


def g_flavor(rng, i):
    return fmt(rng.randint(1, 3), "".join(rng.choice("abcd") for _ in range(rng.randint(1, 12))))


add(
    id="flavor-limit",
    title="Flavor Limit",
    diff="medium",
    pat="sliding-window",
    st="An ice-cream cart sells scoops in a fixed row, each scoop labelled with a lowercase letter for its flavor. A customer wants one unbroken run of scoops but will accept at most k different flavors. Find the longest run they can take.",
    inf="Line 1: k. Line 2: a string of lowercase letters (the row of scoops).",
    outf="One integer: the length of the longest run containing at most k different letters.",
    cons=["1 <= k <= 26", "1 <= length of the string <= 50000", "Only lowercase letters a-z"],
    solve=s_flavor,
    brute=b_flavor,
    wrong=w_flavor,
    gen=g_flavor,
    big=lambda rng: fmt(3, "".join(rng.choice("abcdef") for _ in range(30000))),
    ex=[
        ("2\nabcbbbbcccbdddadacb\n", "10", "The run bcbbbbcccb uses only b and c."),
        ("3\nabaccc\n", "6", "The whole row uses exactly the three flavors a, b, c."),
    ],
    known=[("3\naaa\n", "3"), ("1\nabc\n", "1"), ("2\neceba\n", "3"), ("26\nabcdefghijklmnopqrstuvwxyz\n", "26")],
)


# ---------------------------------------------------------------- stack
def s_warm(inp):
    d = ints(inp)
    n, a = d[0], d[1 : 1 + d[0]]
    res = [0] * n
    st = []
    for i, x in enumerate(a):
        while st and a[st[-1]] < x:
            j = st.pop()
            res[j] = i - j
        st.append(i)
    return row(res) + "\n"


def b_warm(inp):
    d = ints(inp)
    n, a = d[0], d[1 : 1 + d[0]]
    if n > 300:
        return None
    return row([next((j - i for j in range(i + 1, n) if a[j] > a[i]), 0) for i in range(n)]) + "\n"


def w_warm(inp):  # treats an equal reading as warmer
    d = ints(inp)
    n, a = d[0], d[1 : 1 + d[0]]
    return row([next((j - i for j in range(i + 1, n) if a[j] >= a[i]), 0) for i in range(n)]) + "\n"


def g_warm(rng, i):
    n = rng.randint(1, 10)
    return fmt(n, row([rng.randint(0, 5) for _ in range(n)]))


add(
    id="next-warmer-day",
    title="Next Warmer Day",
    diff="medium",
    pat="stack",
    st="A hiker has a forecast of daily peak temperatures. For each day, report how many days she must wait until a strictly warmer day arrives, or 0 if no later day is warmer.",
    inf="Line 1: n. Line 2: n integers (the temperatures in day order).",
    outf="n integers separated by single spaces on one line: the wait for each day in order.",
    cons=["1 <= n <= 20000", "-100 <= temperature <= 100"],
    solve=s_warm,
    brute=b_warm,
    wrong=w_warm,
    gen=g_warm,
    big=lambda rng: fmt(9000, row([rng.randint(-50, 50) for _ in range(9000)])),
    ex=[
        ("7\n20 18 19 25 22 21 30\n", "3 1 1 3 2 1 0", "Day 1 (20) waits until 25 on day 4; day 6 (21) waits one day for 30."),
        ("3\n9 9 10\n", "2 1 0", "The equal 9 does not count as warmer."),
    ],
    known=[("1\n5\n", "0"), ("3\n5 5 5\n", "0 0 0"), ("4\n4 3 2 1\n", "0 0 0 0"), ("4\n1 2 3 4\n", "1 1 1 0")],
)


def s_board(inp):
    d = ints(inp)
    n, h = d[0], d[1 : 1 + d[0]] + [0]
    st, best = [], 0
    for i, x in enumerate(h):
        start = i
        while st and st[-1][1] >= x:
            s, hh = st.pop()
            best = max(best, hh * (i - s))
            start = s
        st.append((start, x))
    return f"{best}\n"


def b_board(inp):
    d = ints(inp)
    n, h = d[0], d[1 : 1 + d[0]]
    if n > 150:
        return None
    return f"{max(min(h[i:j]) * (j - i) for i in range(n) for j in range(i + 1, n + 1))}\n"


def w_board(inp):  # extends each bar to the right only
    d = ints(inp)
    n, h = d[0], d[1 : 1 + d[0]]
    best = 0
    for i in range(n):
        j = i
        while j < n and h[j] >= h[i]:
            j += 1
        best = max(best, h[i] * (j - i))
    return f"{best}\n"


def g_board(rng, i):
    n = rng.randint(1, 9)
    return fmt(n, row([rng.randint(0, 6) for _ in range(n)]))


add(
    id="billboard-skyline",
    title="Billboard Skyline",
    diff="hard",
    pat="stack",
    st="A row of n adjacent towers, each one unit wide, has the given heights (a height may be 0). A billboard is a rectangle with sides along the grid that must fit entirely inside the union of the towers: it spans some run of consecutive towers and its height cannot exceed the shortest tower in that run. Find the largest billboard area.",
    inf="Line 1: n. Line 2: n integers (tower heights, left to right).",
    outf="One integer: the maximum rectangle area.",
    cons=["1 <= n <= 20000", "0 <= height <= 1000000000", "The answer fits in a signed 64-bit integer"],
    solve=s_board,
    brute=b_board,
    wrong=w_board,
    gen=g_board,
    big=lambda rng: fmt(9000, row([rng.randint(0, 1000) for _ in range(9000)])),
    ex=[
        ("7\n4 2 0 3 2 5 1\n", "6", "Towers 3, 2, 5 form a run whose shortest tower is 2: 2 x 3 = 6."),
        ("3\n6 6 6\n", "18", "All three towers share height 6."),
    ],
    known=[("1\n0\n", "0"), ("3\n3 2 3\n", "6"), ("5\n2 1 2 1 2\n", "5"), ("1\n1000000000\n", "1000000000")],
)


# ---------------------------------------------------------------- two-pointers
def s_lantern(inp):
    s = inp.rstrip("\n")
    i, j = 0, len(s) - 1
    while i < j:
        if not s[i].isalnum():
            i += 1
        elif not s[j].isalnum():
            j -= 1
        else:
            if s[i].lower() != s[j].lower():
                return "NO\n"
            i += 1
            j -= 1
    return "YES\n"


def b_lantern(inp):
    f = "".join(ch.lower() for ch in inp if ch.isalnum())
    return "YES\n" if f == f[::-1] else "NO\n"


def w_lantern(inp):  # compares the raw line backwards (no skipping, no case folding)
    s = inp.rstrip("\n")
    return "YES\n" if s == s[::-1] else "NO\n"


def g_lantern(rng, i):
    alpha = "aAbB ,.1"
    half = "".join(rng.choice(alpha) for _ in range(rng.randint(1, 5)))
    s = half + rng.choice(["", "x", " "]) + (half[::-1].swapcase() if i % 2 else half[::-1])
    if i == 4:
        s += rng.choice("ab")
    return s + "\n"


add(
    id="lantern-phrase",
    title="Lantern Phrase",
    diff="easy",
    pat="two-pointers",
    st="A festival banner is read aloud by looking only at letters and digits and ignoring upper/lower case; spaces and punctuation are skipped. The banner is a lantern phrase if it reads the same forwards and backwards under those rules. A banner with no letters or digits at all counts as a lantern phrase.",
    inf="A single line of printable ASCII text (it may contain spaces and punctuation).",
    outf="YES if the banner is a lantern phrase, otherwise NO.",
    cons=["1 <= line length <= 50000", "Printable ASCII only", "Letters and digits are the only characters that count"],
    solve=s_lantern,
    brute=b_lantern,
    wrong=w_lantern,
    gen=g_lantern,
    big=lambda rng: ("Ab, " * 6000 + "x" + " ,bA" * 6000) + "\n",
    ex=[
        ("Never odd or even!\n", "YES", "Keeping letters only: neveroddoreven, which is a palindrome."),
        ("Level 7 vessel\n", "NO", "Keeping letters and digits: level7vessel, reversed lessev7level."),
    ],
    known=[("A man, a plan, a canal: Panama\n", "YES"), ("race a car\n", "NO"), ("!!!\n", "YES"), ("0P\n", "NO")],
)


def s_dock(inp):
    d = ints(inp)
    n, t, a = d[0], d[1], d[2 : 2 + d[0]]
    i, j, r = 0, n - 1, 0
    while i < j:
        s = a[i] + a[j]
        if s < t:
            i += 1
        elif s > t:
            j -= 1
        else:
            r += 1
            x, y = a[i], a[j]
            while i < j and a[i] == x:
                i += 1
            while j > i and a[j] == y:
                j -= 1
    return f"{r}\n"


def b_dock(inp):
    d = ints(inp)
    n, t, a = d[0], d[1], d[2 : 2 + d[0]]
    if n > 300:
        return None
    return f"{len({(a[i], a[j]) for i in range(n) for j in range(i + 1, n) if a[i] + a[j] == t})}\n"


def w_dock(inp):  # counts index pairs (i < j), so repeated values inflate the answer; linear frequency accumulation, same output as the O(n^2) double loop
    d = ints(inp)
    n, t, a = d[0], d[1], d[2 : 2 + d[0]]
    seen = {}
    r = 0
    for x in a:
        r += seen.get(t - x, 0)
        seen[x] = seen.get(x, 0) + 1
    return f"{r}\n"


def g_dock(rng, i):
    n = rng.randint(1, 9)
    return fmt(f"{n} {rng.randint(-2, 6)}", row(sorted(rng.randint(-2, 4) for _ in range(n))))


add(
    id="dock-pairing",
    title="Dock Pairing",
    diff="medium",
    pat="two-pointers",
    st="Cargo crates sit on a dock in non-decreasing order of weight. A crane lifts two different crates at once if their weights add up to exactly the crane's target. Two pairings are the same if they use the same two weights, no matter which physical crates were chosen. Count the distinct weight pairings.",
    inf="Line 1: n and target separated by a space. Line 2: n integers in non-decreasing order.",
    outf="One integer: the number of distinct unordered weight pairs (x, y) with x + y = target that can be formed from two different crates.",
    cons=["1 <= n <= 20000", "-1000000000 <= weight, target <= 1000000000", "Weights are given sorted in non-decreasing order"],
    solve=s_dock,
    brute=b_dock,
    wrong=w_dock,
    gen=g_dock,
    big=lambda rng: fmt("9000 100", row(sorted(rng.randint(0, 200) for _ in range(9000)))),
    ex=[
        ("6 8\n1 2 3 5 5 7\n", "2", "Weights (1,7) and (3,5); the two 5s give one pairing, not two."),
        ("5 4\n2 2 2 2 2\n", "1", "Only the weight pair (2,2) exists, however many crates carry it."),
    ],
    known=[("4 6\n3 3 3 3\n", "1"), ("1 4\n2\n", "0"), ("5 0\n-2 -1 0 1 2\n", "2"), ("6 10\n1 2 5 5 5 9\n", "2")],
)


def s_wall(inp):
    d = ints(inp)
    n, h = d[0], d[1 : 1 + d[0]]
    i, j, best = 0, n - 1, 0
    while i < j:
        best = max(best, min(h[i], h[j]) * (j - i))
        if h[i] < h[j]:
            i += 1
        else:
            j -= 1
    return f"{best}\n"


def b_wall(inp):
    d = ints(inp)
    n, h = d[0], d[1 : 1 + d[0]]
    if n > 400:
        return None
    return f"{max(min(h[i], h[j]) * (j - i) for i in range(n) for j in range(i + 1, n))}\n"


def w_wall(inp):  # only ever looks at the two outermost walls
    d = ints(inp)
    n, h = d[0], d[1 : 1 + d[0]]
    return f"{min(h[0], h[-1]) * (n - 1)}\n"


def g_wall(rng, i):
    n = rng.randint(2, 9)
    return fmt(n, row([rng.randint(0, 9) for _ in range(n)]))


add(
    id="reservoir-walls",
    title="Reservoir Walls",
    diff="medium",
    pat="two-pointers",
    st="A valley has n vertical walls standing one unit apart along a line, with the given heights. A reservoir is formed by choosing two different walls: its width is the distance between them and the water level is the lower of the two heights. Find the largest reservoir area (width times water level). Walls in between do not matter.",
    inf="Line 1: n. Line 2: n integers (wall heights, left to right).",
    outf="One integer: the maximum area over all pairs of walls.",
    cons=["2 <= n <= 20000", "0 <= height <= 1000000000", "The answer fits in a signed 64-bit integer"],
    solve=s_wall,
    brute=b_wall,
    wrong=w_wall,
    gen=g_wall,
    big=lambda rng: fmt(9000, row([rng.randint(0, 5000) for _ in range(9000)])),
    ex=[
        ("6\n3 9 2 8 4 7\n", "28", "Walls of height 9 (index 1) and 7 (index 5): 4 x 7 = 28."),
        ("2\n4 4\n", "4", "The only pair is distance 1 apart at level 4."),
    ],
    known=[("2\n0 0\n", "0"), ("2\n5 7\n", "5"), ("3\n1 1000000000 1\n", "2"), ("4\n1 8 6 2\n", "6")],
)
