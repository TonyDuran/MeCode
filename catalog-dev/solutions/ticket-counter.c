/* Regression solution (C17) for ticket-counter: count copies by a linear scan per query. */
#include <stdio.h>

static long long a[8005];

int main(void) {
    int n, q;
    if (scanf("%d %d", &n, &q) != 2) return 1;
    for (int i = 0; i < n; i++) scanf("%lld", &a[i]);
    for (int j = 0; j < q; j++) {
        long long x;
        scanf("%lld", &x);
        int c = 0;
        for (int i = 0; i < n; i++) if (a[i] == x) c++;
        printf("%d%c", c, j + 1 < q ? ' ' : '\n');
    }
    return 0;
}
