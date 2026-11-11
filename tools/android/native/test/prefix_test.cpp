// Проверка чистой части кэша llama (common_prefix) на хосте: g++ -std=c++17 native/test/prefix_test.cpp -o /tmp/prefix_test && /tmp/prefix_test
#include <algorithm>
#include <cassert>
#include <cstdio>
#include <vector>
typedef int llama_token;
static size_t common_prefix(const std::vector<llama_token>& a, const std::vector<llama_token>& b) {
    size_t n = std::min(a.size(), b.size()), i = 0;
    while (i < n && a[i] == b[i]) i++;
    return i;
}
int main() {
    assert(common_prefix({}, {1, 2}) == 0);
    assert(common_prefix({1, 2, 3}, {1, 2, 3}) == 3);
    assert(common_prefix({1, 2, 3, 4}, {1, 2, 9}) == 2);
    assert(common_prefix({1, 2}, {1, 2, 3, 4}) == 2);
    assert(common_prefix({7}, {8}) == 0);
    // как в generate(): последний токен пересчитывается всегда
    std::vector<llama_token> cached = {1, 2, 3, 4, 5}, toks = {1, 2, 3, 4, 5};
    size_t keep = common_prefix(cached, toks); if (keep >= toks.size()) keep = toks.size() - 1;
    assert(keep == 4);
    std::puts("prefix ok");
}
