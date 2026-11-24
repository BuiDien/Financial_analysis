from app.services import news_feeds as s


def item(url, title="x", published=1000, source="t"):
    return {"id": "", "title": title, "url": url, "source": source,
            "published": published, "summary": ""}


def test_mentions_word_boundary():
    assert s.mentions("HPG tăng trần", ["HPG"])
    assert not s.mentions("HPGX tăng trần", ["HPG"])
    assert s.mentions("Tập đoàn Hòa Phát báo lãi", ["HPG", "Hòa Phát"])


def test_fetch_all_vn_dedups_by_url():
    f = {"a": lambda: [item("u1")], "b": lambda: [item("u1")]}
    items, errs = s.fetch_all_vn(f)
    assert len(items) == 1 and errs == []


def test_failing_source_reported_not_raised():
    def boom():
        raise RuntimeError("boom")
    items, errs = s.fetch_all_vn({"vietstock": boom, "cafef": lambda: [item("u1")]})
    assert errs == ["vietstock: boom"]
    assert len(items) == 1


def test_match_drops_old_items():
    items = [item("old", "HPG cũ", 10), item("zero", "HPG không ngày", 0),
             item("new", "HPG mới", 500)]
    got, errs = s.match_holding_news(items, ["HPG"], 100, search=lambda q, n: [])
    assert {i["url"] for i in got} == {"zero", "new"} and errs == []


def test_searxng_search_always_runs_and_merges():
    calls = []

    def search(q, n):
        calls.append((q, n))
        return [{"title": "Hòa Phát", "url": "http://s", "content": "HPG"},
                {"title": "dup HPG", "url": "u", "content": ""}]
    got, _ = s.match_holding_news([], ["HPG", "Hòa Phát"], 0, search=search)
    assert calls == [('"Hòa Phát" cổ phiếu', 5)] and len(got) == 2
    calls.clear()
    got, errs = s.match_holding_news([item("u", "HPG")], ["HPG"], 0, search=search)
    assert calls == [('"HPG" cổ phiếu', 5)] and errs == []
    assert [i["url"] for i in got] == ["u", "http://s"]  # deduped by URL, RSS first


def test_search_keeps_published_date_and_drops_old():
    def search(q, n):
        return [{"title": "new", "url": "n", "content": "HPG", "published": "2026-11-12T10:00:00Z"},
                {"title": "naive", "url": "v", "content": "HPG", "published": "2026-11-12T10:00:00"},
                {"title": "old", "url": "o", "content": "HPG", "published": "2026-10-01T10:00:00+07:00"},
                {"title": "undated", "url": "z", "content": "HPG", "published": ""}]
    since = 1_794_000_000  # 2026-11-06; "old" (2026-10-01) is before it
    got, errs = s.match_holding_news([], ["HPG"], since, search=search)
    by = {i["url"]: i for i in got}
    assert set(by) == {"n", "v", "z"} and errs == []
    import calendar
    import datetime
    exp = calendar.timegm(datetime.datetime(2026, 11, 12, 10).timetuple())
    assert by["n"]["published"] == exp and by["v"]["published"] == exp
    assert by["z"]["published"] == 0 and by["n"]["source"] == "searxng"


def test_search_general_fallback_is_a_source_error():
    def search(q, n):
        return [{"title": "x", "url": "g", "content": "", "fallback": True}]
    got, errs = s.match_holding_news([], ["HPG"], 0, search=search)
    assert got == [] and errs == ["searxng: no news results"]


def test_fallback_failure_goes_to_errors():
    def search(q, n):
        raise RuntimeError("down")
    got, errs = s.match_holding_news([], ["HPG"], 0, search=search)
    assert got == [] and len(errs) == 1 and "down" in errs[0]


RSS = b"""<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>HPG</title><link>http://x/1</link><description>d</description>
<pubDate>Fri, 13 Nov 2026 10:00:00 +0700</pubDate></item></channel></rss>"""


def test_vietstock_default_keys_are_per_feed():
    keys = set(s.DEFAULT_VN_FETCHERS)
    assert {"vietstock/co-phieu", "vietstock/doanh-nghiep", "vietstock/co-tuc",
            "vietstock/giao-dich-noi-bo", "cafef"} <= keys


def test_one_vietstock_feed_failing_is_reported_others_returned(monkeypatch):
    def get(url):
        if "co-tuc" in url:
            raise OSError("timeout")
        return RSS.replace(b"http://x/1", url.encode())
    monkeypatch.setattr(s, "http_get", get)
    fetchers = {k: f for k, f in s.DEFAULT_VN_FETCHERS.items() if k.startswith("vietstock/")}
    items, errs = s.fetch_all_vn(fetchers)
    assert errs == ["vietstock/co-tuc: timeout"]
    assert len(items) == 3
    assert {i["source"] for i in items} == {"vietstock"}


def test_html_error_page_is_a_failure():
    html = b"<html><body><h1>Service unavailable</h1></body></html>"
    items, errs = s.fetch_all_vn({"v": lambda: s.parse_feed(html, "vietstock")})
    assert items == [] and len(errs) == 1 and errs[0].startswith("v: unparseable feed")


def test_parse_feed_raw_bytes_dates_and_limits():
    import calendar
    import datetime
    entries = "".join(f"<item><title>T{i}</title><link>https://r/{i}</link>"
                      f"<description>&lt;b&gt;{'x' * 50}&lt;/b&gt;</description></item>"
                      for i in range(5))
    rss = f'<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>{entries}</channel></rss>'
    got = s.parse_feed(rss.encode(), "rss/F", limit=3, summary_limit=10)
    assert [i["url"] for i in got] == ["https://r/0", "https://r/1", "https://r/2"]
    assert got[0] == {"id": "", "title": "T0", "url": "https://r/0", "source": "rss/F",
                      "published": 0, "summary": "x" * 10}
    dated = s.parse_feed(RSS, "vietstock")
    assert dated[0]["published"] == calendar.timegm(datetime.datetime(2026, 11, 13, 3).timetuple())


def test_parse_feed_fetches_urls_via_http_get(monkeypatch):
    urls = []
    monkeypatch.setattr(s, "http_get", lambda url: urls.append(url) or RSS)
    got = s.parse_feed("https://feed/rss", "vietstock")
    assert urls == ["https://feed/rss"] and got[0]["url"] == "http://x/1"


def test_dedupe_by_url_keeps_first_in_order():
    a, b, a2 = item("a", "first"), item("b"), item("a", "second")
    assert s.dedupe_by_url([a, b, a2]) == [a, b]
    assert s.dedupe_by_url([]) == []


def test_search_uses_explicit_brand():
    queries = []

    def search(q, n):
        queries.append(q)
        return [{"title": "Hoa Phat Group lãi", "url": "h", "content": ""}]
    got, errs = s.match_holding_news([], ["HPG", "Hòa Phát"], 0, search, brand="Hoa Phat Group")
    assert queries == ['"Hoa Phat Group" cổ phiếu'] and errs == []
    assert got == []  # brand is only the query; the hit must still name the holding


def test_mentions_decomposed_unicode():
    import unicodedata
    nfd = unicodedata.normalize("NFD", "Tập đoàn Hòa Phát báo lãi")
    assert nfd != unicodedata.normalize("NFC", nfd)
    assert s.mentions(nfd, ["HPG", "Hòa Phát"])


def test_search_results_must_name_the_holding():
    def search(q, n):
        return [{"title": "Thị trường giảm mạnh", "url": "off", "content": "VN-Index mất điểm"},
                {"title": "Lãi quý 3", "url": "body", "content": "Tập đoàn Hòa Phát báo lãi"},
                {"title": "HPGX lên sàn", "url": "lookalike", "content": ""}]
    got, errs = s.match_holding_news([], ["HPG", "Hòa Phát"], 0, search=search)
    assert [i["url"] for i in got] == ["body"] and errs == []


# --- test-gap round (2026-11-15) ---
def test_search_epoch_formats():
    assert s.search_epoch("2026-11-13T08:00:00Z") == 1794556800
    assert s.search_epoch("2026-11-13T08:00:00") == 1794556800  # naive = UTC
    assert s.search_epoch("2026-11-13T15:00:00+07:00") == 1794556800
    assert s.search_epoch("") == 0
    assert s.search_epoch(None) == 0
    assert s.search_epoch("yesterday") == 0


def test_search_query_prefers_brand_then_ticker():
    queries = []

    def search(q, n):
        queries.append(q)
        return []
    s.match_holding_news([], ["HPG", "Hòa Phát"], 0, search)
    s.match_holding_news([], ["HPG"], 0, search)
    assert queries == ['"Hòa Phát" cổ phiếu', '"HPG" cổ phiếu']


def test_no_names_means_no_search():
    def search(q, n):
        raise AssertionError("search must not run")
    assert s.match_holding_news([item("u1", "HPG")], [], 0, search) == ([], [])
