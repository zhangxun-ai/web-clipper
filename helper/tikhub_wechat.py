"""Fixed TikHub list adapter. Keys and raw provider responses stay on this Mac."""

import json
import os
from pathlib import Path
import re
import socket
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, unquote_plus, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
import hashlib

ENDPOINT = "https://api.tikhub.io/api/v1/wechat_mp/v2/fetch_account_articles"
CACHE_SECONDS = 300
MAX_CACHE_PAGES = 500
MAX_RESPONSE = 4 * 1024 * 1024


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def load_key():
    values = {}
    path = Path(__file__).resolve().parents[1] / ".env"
    try:
        if path.is_file():
            for line in path.read_text(encoding="utf-8").splitlines():
                match = re.fullmatch(r"\s*(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*?)\s*", line)
                if match:
                    value = match[2]
                    if value[:1] in ("'", '"') and value[-1:] == value[:1]:
                        value = value[1:-1]
                    else:
                        value = re.split(r"\s+#", value, maxsplit=1)[0].strip()
                    values[match[1].lower()] = value
    except (OSError, UnicodeError):
        pass
    key = values.get("tikhub_api_key") or os.environ.get("TIKHUB_API_KEY") or os.environ.get("tikhub_api_key") or ""
    return key if isinstance(key, str) and 1 <= len(key) <= 8192 and not re.search(r"\s", key) else ""


def article_url(value, biz, error):
    try:
        if not isinstance(value, str) or len(value) > 8192 or re.search(r"[\x00-\x20\x7f]", value):
            raise ValueError()
        parsed = urlsplit(value)
        query = parse_qs(parsed.query)
        if (parsed.scheme not in ("http", "https") or parsed.hostname != "mp.weixin.qq.com"
                or parsed.username or parsed.password or parsed.port not in (None, 80, 443)
                or parsed.path != "/s" or query.get("__biz") != [biz]
                or any(len(query.get(name, [])) != 1 for name in ("mid", "idx", "sn"))
                or not re.fullmatch(r"[0-9]{1,20}", query.get("mid", [""])[0])
                or not re.fullmatch(r"[1-9][0-9]?", query.get("idx", [""])[0])
                or not re.fullmatch(r"[a-fA-F0-9]{32}", query.get("sn", [""])[0])
                or ("chksm" in query and (len(query["chksm"]) != 1 or not re.fullmatch(r"[a-fA-F0-9]{8,128}", query["chksm"][0])))
                or ("scene" in query and (len(query["scene"]) != 1 or not re.fullmatch(r"[0-9]{1,5}", query["scene"][0])))):
            raise ValueError()
        # WeChat requires the signed chksm on some public articles. Keep its
        # original query encoding, but remove session/tracking parameters.
        allowed = {"__biz", "mid", "idx", "sn", "chksm", "scene"}
        public_query = "&".join(part for part in parsed.query.split("&") if unquote_plus(part.split("=", 1)[0]) in allowed)
        return "https://mp.weixin.qq.com/s?" + public_query
    except (ValueError, TypeError, AttributeError):
        raise error("TikHub 返回的文章链接或公众号身份不符，已停止下载。", "TIKHUB_INVALID_RESPONSE")


class WechatProvider:
    def __init__(self, store, error, opener=None, key_loader=None):
        self.store, self.error = store, error
        self.opener = opener or build_opener(NoRedirect())
        self.key_loader = key_loader or load_key

    def status(self):
        return {"available": True, "configured": bool(self.key_loader()), "source": "tikhub"}

    def failure(self, message, code, started, category, http_status=None, payload=None, key=""):
        error = self.error(message, code)
        details = {"elapsedMs": max(0, round((time.monotonic() - started) * 1000)),
                   "cached": False, "category": category}
        if http_status is not None:
            details["httpStatus"] = http_status
        # Only a UUID request identifier is permitted through. Never forward
        # provider messages, URLs, headers, debug fields or arbitrary codes.
        if isinstance(payload, dict):
            nested = payload.get("detail")
            request_id = payload.get("request_id") or (nested.get("request_id") if isinstance(nested, dict) else None)
            if (isinstance(request_id, str) and request_id != key
                    and re.fullmatch(r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}", request_id)):
                details["providerRequestId"] = request_id
        error.wechat_details = details
        return error

    def page(self, params):
        started = time.monotonic()
        username, biz, offset = params.get("username"), params.get("biz"), params.get("offset", "")
        if (not isinstance(username, str) or not re.fullmatch(r"gh_[A-Za-z0-9]{1,64}", username)
                or not isinstance(biz, str) or not re.fullmatch(r"Mz[A-Za-z0-9+/=]{4,126}", biz)
                or not isinstance(offset, str) or len(offset) > 4096 or re.search(r"[\x00-\x20\x7f]", offset)):
            raise self.error("公众号或分页参数无效。", "INVALID_PARAMS")
        key = self.key_loader()
        if not key:
            raise self.error("未配置 TikHub，请在本机项目 .env 中设置 TIKHUB_API_KEY。", "TIKHUB_NOT_CONFIGURED")
        cache_key = hashlib.sha256(json.dumps([4, username, biz, offset]).encode()).hexdigest()
        # Separate from the Feishu journal lock: a list request must not hold up saves.
        with self.store.locked():
            cache = self.store.read("pages.json", {})
            if not isinstance(cache, dict):
                cache = {}
            saved = cache.get(cache_key, {})
            if (isinstance(saved, dict) and isinstance(saved.get("data"), dict)
                    and type(saved.get("at")) in (int, float)
                    and 0 <= time.time() - saved["at"] < CACHE_SECONDS):
                saved["accessedAt"] = time.time()
                self.store.write("pages.json", cache)
                return {**saved["data"], "cached": True,
                        "elapsedMs": max(0, round((time.monotonic() - started) * 1000))}
            # Simplified responses lose sendTime and expose material dates.
            body = {"username": username, "raw": True, "item_show_type": 0}
            if offset:
                body["offset"] = offset  # Opaque provider cursor, never decoded or incremented.
            request = Request(ENDPOINT, data=json.dumps(body).encode(), method="POST", headers={
                "Authorization": "Bearer " + key, "Content-Type": "application/json",
                "User-Agent": "WebClipper/0.4.9"})
            try:
                with self.opener.open(request, timeout=45) as response:
                    raw = response.read(MAX_RESPONSE + 1)
                if len(raw) > MAX_RESPONSE:
                    raise ValueError()
                payload = json.loads(raw)
            except HTTPError as exc:
                provider_error = None
                try:
                    raw_error = exc.read(MAX_RESPONSE + 1)
                    if len(raw_error) <= MAX_RESPONSE:
                        provider_error = json.loads(raw_error)
                except (ValueError, UnicodeError, OSError):
                    pass
                finally:
                    exc.close()
                text, category = {
                    400: ("TikHub 返回 HTTP 400，供应商未成功处理本次列表请求，具体原因尚未确认。", "http_error"),
                    401: ("TikHub 密钥无效或已失效（HTTP 401）。", "authentication"),
                    402: ("TikHub 余额不足（HTTP 402）。", "billing"),
                    403: ("TikHub 拒绝访问，请检查密钥权限或服务状态（HTTP 403）。", "access_denied"),
                    429: ("TikHub 请求受限，请稍后继续（HTTP 429）。", "rate_limited"),
                }.get(exc.code, ("TikHub 列表请求失败（HTTP " + str(exc.code) + "）。", "http_error"))
                raise self.failure(text + " 未自动重试，已保留列表进度。", "TIKHUB_HTTP_" + str(exc.code),
                                   started, category, exc.code, provider_error, key) from None
            except (URLError, TimeoutError, socket.timeout, OSError):
                raise self.failure("TikHub 请求超时或网络不可用；可能已计费，未自动重试，进度已保留。",
                                   "TIKHUB_NETWORK", started, "network") from None
            except (ValueError, UnicodeError):
                raise self.failure("TikHub 返回格式无法识别。", "TIKHUB_INVALID_RESPONSE",
                                   started, "invalid_response") from None
            try:
                result = self.parse(payload, username, biz, offset)
            except self.error as exc:
                raise self.failure(str(exc), exc.code, started, "provider_response", 200, payload, key) from None
            now = time.time()
            cache[cache_key] = {"at": now, "accessedAt": now, "data": result}
            # Expired pages remain available for local diagnosis, but cannot
            # satisfy requests. Bound disk usage independently of freshness.
            def last_access(entry):
                value = entry[1].get("accessedAt", entry[1].get("at", 0))
                return value if type(value) in (int, float) else 0
            entries = [(k, v) for k, v in cache.items() if isinstance(v, dict)]
            cache = dict(sorted(entries, key=last_access)[-MAX_CACHE_PAGES:])
            self.store.write("pages.json", cache)
            return {**result, "cached": False,
                    "elapsedMs": max(0, round((time.monotonic() - started) * 1000))}

    def parse(self, payload, username, biz, offset):
        error = self.error
        if not isinstance(payload, dict) or payload.get("code") != 200:
            raise error("TikHub 未成功返回文章列表，已保留进度。", "TIKHUB_PROVIDER_ERROR")
        data = payload.get("data")
        if not isinstance(data, dict) or data.get("biz_username") != username:
            raise error("TikHub 返回的公众号身份不符。", "TIKHUB_ACCOUNT_MISMATCH")
        items, is_end, cursor = data.get("articles"), data.get("is_end"), data.get("next_offset", "") or ""
        if (not isinstance(items, list) or len(items) > 500 or is_end not in (0, 1, False, True)
                or not isinstance(cursor, str) or len(cursor) > 4096 or re.search(r"[\x00-\x20\x7f]", cursor)
                or (not is_end and (not cursor or cursor == offset or not items))):
            raise error("TikHub 分页结果不完整或游标异常，已停止并保留进度。", "TIKHUB_CURSOR_INVALID")
        articles = []
        for item in items:
            if not isinstance(item, dict):
                raise error("TikHub 文章格式不完整。", "TIKHUB_INVALID_RESPONSE")
            if "appMsg" in item:
                app = item.get("appMsg")
                details = app.get("detailInfo") if isinstance(app, dict) else None
                if not isinstance(details, list) or not details or len(details) > 100:
                    raise error("TikHub 原始图文格式不完整。", "TIKHUB_INVALID_RESPONSE")
                for detail in details:
                    if not isinstance(detail, dict) or not isinstance(detail.get("title"), str) or len(detail["title"]) > 4096:
                        raise error("TikHub 原始文章格式不完整。", "TIKHUB_INVALID_RESPONSE")
                    timestamp = detail.get("sendTime")
                    source = "article"
                    if type(timestamp) is not int or not 946684800 <= timestamp <= 4102444800:
                        base = item.get("baseInfo")
                        timestamp = base.get("dateTime") if isinstance(base, dict) else None
                        source = "message"
                        if type(timestamp) is not int or not 946684800 <= timestamp <= 4102444800:
                            # No invented date: the extension must read original ct.
                            timestamp = None
                    articles.append({"title": detail["title"], "url": article_url(detail.get("contentUrl"), biz, error),
                                     "publishTimestamp": timestamp, "publicationSource": source})
            else:
                # Compatible cached/fixture envelope, never treat material dates
                # as publication time. A missing sendTime requires original ct.
                if not isinstance(item.get("title"), str) or len(item["title"]) > 4096:
                    raise error("TikHub 文章格式不完整。", "TIKHUB_INVALID_RESPONSE")
                articles.append({"title": item["title"], "url": article_url(item.get("url"), biz, error),
                                 "publishTimestamp": None})
        return {"source": "tikhub", "account": {"username": username, "fakeid": biz},
                "articles": articles, "isEnd": bool(is_end), "nextOffset": cursor}
