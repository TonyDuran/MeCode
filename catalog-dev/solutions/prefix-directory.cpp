// Regression solution (C++17) for prefix-directory: count every prefix of every stored name.
#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);
    int n, q;
    cin >> n >> q;
    unordered_map<string, long long> cnt;
    for (int i = 0; i < n; i++) {
        string w;
        cin >> w;
        for (size_t k = 1; k <= w.size(); k++) cnt[w.substr(0, k)]++;
    }
    for (int i = 0; i < q; i++) {
        string p;
        cin >> p;
        auto it = cnt.find(p);
        cout << (it == cnt.end() ? 0 : it->second) << (i + 1 < q ? " " : "\n");
    }
    return 0;
}
