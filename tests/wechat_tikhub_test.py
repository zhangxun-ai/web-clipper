"""Provider and Native Messaging contract tests; no network or real key reads."""

import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "helper"))
from feishu_native_host import HostError, StateStore
from tikhub_wechat import WechatProvider
from wechat_native_host import WechatHost, WechatHostError
from install_wechat_native_host import install

BIZ = "MzE5ODg1MTY4Mw=="
USERNAME = "gh_6990113d8818"
CURSOR = "WABgAGiBxpWv3+G5jWk="
KEY = "TEST_CREDENTIAL_MUST_NOT_LEAK"
URL = "http://mp.weixin.qq.com/s?__biz=" + BIZ + "&mid=2247484930&idx=1&sn=9e891983735589c14c09cd4fd06f4638&chksm=97a11a9c60d53f48&scene=126&sessionid=PRIVATE_TRACKING"


def payload():
    return {"code": 200, "data": {"biz_username": USERNAME, "is_end": 0, "next_offset": CURSOR,
            "articles": [{"title": "真实 V2 契约", "url": URL, "create_time": 1788677167, "update_time": 1788883884}],
            "debug_info": {"key": KEY}}}


class FakeOpener:
    def __init__(self):
        self.calls = []
        self.responses = [payload()]

    def open(self, request, timeout):
        self.calls.append((request, timeout))
        value = self.responses.pop(0)
        if isinstance(value, Exception):
            raise value
        return io.BytesIO(json.dumps(value).encode())


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wechat-provider-test-")
        self.addCleanup(self.temp.cleanup)
        self.store = StateStore(Path(self.temp.name).resolve() / "state")
        self.opener = FakeOpener()
        self.provider = WechatProvider(self.store, HostError, self.opener, lambda: KEY)
        self.host = WechatHost(self.store.directory, self.provider)

    def test_real_envelope_normalizes_urls_and_caches_without_credentials(self):
        params = {"username": USERNAME, "biz": BIZ}
        first = self.provider.page(params)
        self.assertEqual(first["nextOffset"], CURSOR)
        self.assertFalse(first["isEnd"])
        self.assertEqual(len(first["articles"]), 1)  # A short non-final page is valid.
        self.assertTrue(first["articles"][0]["url"].startswith("https://mp.weixin.qq.com/s?"))
        request, timeout = self.opener.calls[0]
        self.assertEqual(json.loads(request.data), {"username": USERNAME, "raw": True, "item_show_type": 0})
        self.assertIn("chksm=97a11a9c60d53f48", first["articles"][0]["url"])
        self.assertIn("__biz=" + BIZ, first["articles"][0]["url"])
        self.assertEqual(request.get_header("Authorization"), "Bearer " + KEY)
        self.assertTrue(request.get_header("User-agent"))
        self.assertEqual(timeout, 45)
        second = self.provider.page(params)
        self.assertTrue(second["cached"])
        self.assertEqual(len(self.opener.calls), 1)
        text = json.dumps(first) + (self.store.directory / "pages.json").read_text()
        for secret in (KEY, "debug_info", "PRIVATE_TRACKING"):
            self.assertNotIn(secret, text)

    def test_opaque_cursor_is_sent_unchanged_in_post_body(self):
        self.opener.responses = [{"code": 200, "data": {"biz_username": USERNAME, "is_end": 1, "next_offset": "", "articles": []}}]
        result = self.provider.page({"username": USERNAME, "biz": BIZ, "offset": CURSOR})
        self.assertTrue(result["isEnd"])
        self.assertEqual(json.loads(self.opener.calls[0][0].data)["offset"], CURSOR)

    def test_raw_group_keeps_all_articles_and_send_time_not_material_dates(self):
        value = payload()
        details = [{"title": "原始正文", "contentUrl": URL, "sendTime": 1788739200},
                   {"title": "同组第二篇", "contentUrl": URL.replace("idx=1", "idx=2"), "sendTime": 1788739260}]
        value["data"]["articles"] = [{"baseInfo": {"dateTime": 1788739140}, "appMsg": {
            "baseInfo": {"createTime": 1788677167, "updateTime": 1788883884}, "detailInfo": details}}]
        result = self.provider.parse(value, USERNAME, BIZ, "")
        self.assertEqual([a["publishTimestamp"] for a in result["articles"]], [1788739200, 1788739260])
        self.assertEqual(len(result["articles"]), 2)
        details[0]["sendTime"] = 0
        fallback = self.provider.parse(value, USERNAME, BIZ, "")["articles"][0]
        self.assertEqual(fallback["publishTimestamp"], 1788739140)
        self.assertEqual(fallback["publicationSource"], "message")
        value["data"]["articles"][0]["baseInfo"]["dateTime"] = 0
        self.assertIsNone(self.provider.parse(value, USERNAME, BIZ, "")["articles"][0]["publishTimestamp"])
        value["data"]["articles"][0]["appMsg"]["detailInfo"] = []
        with self.assertRaises(HostError):
            self.provider.parse(value, USERNAME, BIZ, "")

    def test_bad_identity_urls_or_cursor_fail_without_partial_success(self):
        mutations = [
            lambda value: value["data"].update(biz_username="gh_wrong"),
            lambda value: value["data"].update(next_offset=""),
            lambda value: value["data"].update(is_end="0"),
            lambda value: value["data"].update(articles=[]),
            lambda value: value["data"]["articles"][0].update(url="https://evil.example/s"),
            lambda value: value["data"]["articles"][0].update(url=URL.replace(BIZ, "MzWrong==")),
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                value = payload(); mutate(value)
                with self.assertRaises(HostError):
                    self.provider.parse(value, USERNAME, BIZ, "")
        with self.assertRaises(HostError):
            self.provider.parse(payload(), USERNAME, BIZ, CURSOR)

    def test_http_and_timeout_errors_never_retry_or_return_provider_secrets(self):
        for error in [HTTPError("https://api.tikhub.io", 403, KEY, {}, io.BytesIO(KEY.encode())), URLError(KEY)]:
            with self.subTest(error=error):
                self.opener.responses = [error]
                before = len(self.opener.calls)
                result = self.host.handle({"action": "tikhub_article_page", "params": {"username": USERNAME, "biz": BIZ}})
                self.assertFalse(result["ok"])
                self.assertEqual(len(self.opener.calls), before + 1)
                self.assertNotIn(KEY, json.dumps(result))

    def test_http_diagnostics_allowlist_and_no_paid_retry(self):
        request_id = "12345678-1234-1234-1234-123456789abc"
        body = {"detail": {"request_id": request_id, "message": KEY,
                           "token": KEY, "debug": {"headers": KEY, "url": KEY}}}
        for status, category in [(400, "http_error"), (401, "authentication"), (402, "billing"),
                                 (403, "access_denied"), (429, "rate_limited"), (503, "http_error")]:
            with self.subTest(status=status):
                self.opener.responses = [HTTPError("https://api.tikhub.io/" + KEY, status, KEY,
                                                  {"Authorization": KEY}, io.BytesIO(json.dumps(body).encode()))]
                before = len(self.opener.calls)
                with patch("tikhub_wechat.time.monotonic", side_effect=[100.0, 121.6]):
                    result = self.host.handle({"action": "tikhub_article_page", "params": {"username": USERNAME, "biz": BIZ}})
                self.assertEqual(result["details"], {"httpStatus": status, "elapsedMs": 21600,
                                 "cached": False, "category": category, "providerRequestId": request_id})
                self.assertIn("HTTP " + str(status), result["error"])
                self.assertEqual(len(self.opener.calls), before + 1)
                for secret in (KEY, "token", "debug", "headers", "https://"):
                    self.assertNotIn(secret, json.dumps(result))
                if status == 400:
                    self.assertIn("原因尚未确认", result["error"])
                    self.assertNotIn("参数错误", result["error"])

    def test_network_and_unknown_provider_error_remain_unclassified(self):
        for failure in [TimeoutError(KEY), URLError(KEY), {"code": 999, "message": KEY, "request_id": KEY}]:
            with self.subTest(failure=type(failure).__name__):
                self.opener.responses = [failure]
                result = self.host.handle({"action": "tikhub_article_page", "params": {"username": USERNAME, "biz": BIZ}})
                self.assertFalse(result["ok"])
                self.assertIs(type(result["details"]["elapsedMs"]), int)
                self.assertNotIn(KEY, json.dumps(result))
                self.assertNotIn("providerRequestId", result["details"])

    def test_diagnostic_schema_rejects_wrong_types(self):
        error = WechatHostError("safe")
        error.wechat_details = {"elapsedMs": True, "httpStatus": "400", "cached": "false",
                                "category": KEY, "providerRequestId": KEY, "debug": KEY}
        self.assertNotIn("details", error.response())

    def test_elapsed_time_measures_each_call_including_cache_hit(self):
        params = {"username": USERNAME, "biz": BIZ}
        with patch("tikhub_wechat.time.monotonic", side_effect=[10.0, 15.1, 20.0, 20.002]):
            fresh = self.provider.page(params)
            cached = self.provider.page(params)
        self.assertEqual(fresh["elapsedMs"], 5100)
        self.assertEqual(cached["elapsedMs"], 2)
        self.assertIs(type(fresh["elapsedMs"]), int)
        self.assertFalse(fresh["cached"])
        self.assertTrue(cached["cached"])

    def test_expired_pages_are_retained_but_not_served_and_cache_is_bounded(self):
        params = {"username": USERNAME, "biz": BIZ}
        self.provider.page(params)
        cache = self.store.read("pages.json", {})
        key = next(iter(cache))
        cache[key]["at"] = 1
        cache[key]["accessedAt"] = 1
        cache["other-expired"] = {"at": 2, "data": {"historical": True}}
        self.store.write("pages.json", cache)
        self.opener.responses = [payload()]
        self.assertFalse(self.provider.page(params)["cached"])
        self.assertEqual(len(self.opener.calls), 2)
        cache = self.store.read("pages.json", {})
        self.assertIn("other-expired", cache)
        cache.update({"expired-" + str(i): {"at": i, "data": {}} for i in range(600)})
        cache[key]["at"] = 1
        self.store.write("pages.json", cache)
        self.opener.responses = [payload()]
        self.provider.page(params)
        cache = self.store.read("pages.json", {})
        self.assertEqual(len(cache), 500)
        self.assertIn(key, cache)
        self.assertNotIn("expired-0", cache)

    def test_keyless_status_and_fixed_native_allowlist_make_no_api_call(self):
        self.provider.key_loader = lambda: ""
        self.assertEqual(self.host.handle({"action": "tikhub_status"})["data"]["configured"], False)
        result = self.host.handle({"action": "tikhub_article_page", "params": {"username": USERNAME, "biz": BIZ}})
        self.assertEqual(result["code"], "TIKHUB_NOT_CONFIGURED")
        for message in [[], {"action": []}, {"action": "copy_doc"}, {"action": "tikhub_status", "params": {"api_key": KEY}},
                        {"action": "tikhub_article_page", "params": {"url": "https://evil.example"}}]:
            self.assertFalse(self.host.handle(message)["ok"])
        self.assertEqual(self.opener.calls, [])

    def test_new_host_install_preserves_feishu_and_rejects_other_extension(self):
        home = Path(self.temp.name).resolve() / "home"
        folder = home / "Library/Application Support/Google/Chrome/NativeMessagingHosts"
        folder.mkdir(parents=True)
        old = folder / "com.feishu.clipper.json"
        old.write_text("EXISTING_FEISHU_HOST")
        with patch("install_wechat_native_host.sys.executable", sys.executable):
            installed = install("a" * 32, home=home, platform="darwin")
            install("a" * 32, home=home, platform="darwin")
            with self.assertRaises(ValueError):
                install("b" * 32, home=home, platform="darwin")
        self.assertEqual(old.read_text(), "EXISTING_FEISHU_HOST")
        manifest = json.loads(Path(installed["manifest"]).read_text())
        self.assertEqual(manifest["allowed_origins"], ["chrome-extension://" + "a" * 32 + "/"])


if __name__ == "__main__":
    unittest.main()
