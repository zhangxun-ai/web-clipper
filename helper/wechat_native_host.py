#!/usr/bin/env python3
"""Narrow Native Messaging host for paid WeChat lists; independent of Feishu."""

import argparse
import re
import sys
from feishu_native_host import HostError, StateStore, serve
from tikhub_wechat import WechatProvider


class WechatHostError(HostError):
    def response(self):
        result = super().response()
        raw = getattr(self, "wechat_details", {})
        details = {}
        if not isinstance(raw, dict):
            return result
        if type(raw.get("httpStatus")) is int and 100 <= raw["httpStatus"] <= 599:
            details["httpStatus"] = raw["httpStatus"]
        if type(raw.get("elapsedMs")) is int and 0 <= raw["elapsedMs"] <= 86400000:
            details["elapsedMs"] = raw["elapsedMs"]
        if raw.get("cached") is False:
            details["cached"] = False
        if raw.get("category") in ("http_error", "authentication", "billing", "access_denied",
                                   "rate_limited", "network", "invalid_response", "provider_response"):
            details["category"] = raw["category"]
        request_id = raw.get("providerRequestId")
        if isinstance(request_id, str) and re.fullmatch(r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}", request_id):
            details["providerRequestId"] = request_id
        if details:
            result["details"] = details
        return result


class WechatHost:
    ACTION_PARAMS = {"tikhub_status": (), "tikhub_article_page": ("username", "biz", "offset")}

    def __init__(self, state_dir, provider=None):
        self.provider = provider or WechatProvider(StateStore(state_dir), WechatHostError)

    def handle(self, message):
        try:
            if not isinstance(message, dict) or set(message) - {"action", "params"}:
                raise HostError("请求格式无效。", "INVALID_REQUEST")
            action, params = message.get("action"), message.get("params", {})
            if not isinstance(action, str) or action not in self.ACTION_PARAMS:
                raise HostError("不支持此操作。", "UNKNOWN_ACTION")
            if not isinstance(params, dict) or set(params) - set(self.ACTION_PARAMS[action]):
                raise HostError("请求参数无效。", "INVALID_PARAMS")
            data = self.provider.status() if action == "tikhub_status" else self.provider.page(params)
            return {"ok": True, "data": data}
        except HostError as error:
            response_error = WechatHostError(str(error), error.code)
            response_error.wechat_details = getattr(error, "wechat_details", {})
            return response_error.response()
        except Exception:
            return HostError("公众号列表连接发生错误，未创建下载任务。", "TIKHUB_HOST_ERROR").response()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--allowed-origin", required=True)
    parser.add_argument("origin", nargs="?")
    args = parser.parse_args()
    if args.origin != args.allowed_origin:
        return 1
    try:
        serve(WechatHost(args.state_dir), sys.stdin.buffer, sys.stdout.buffer)
    except Exception:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
