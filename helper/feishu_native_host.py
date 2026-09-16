#!/usr/bin/env python3
"""Restricted Native Messaging adapter. Credentials remain managed by lark-cli."""

import argparse
import contextlib
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import struct
import subprocess
import sys
import tempfile
import time
import uuid
from urllib.parse import parse_qs, urlsplit

MAX_MESSAGE = 1024 * 1024
CLI_TIMEOUT = 30
HOST_NAME = "com.feishu.clipper"
SCOPES = (
    "wiki:space:retrieve", "wiki:space:read", "wiki:node:retrieve",
    "wiki:node:read", "wiki:node:move", "docx:document:readonly",
    "offline_access",
    "docx:document:create", "docx:document:write_only", "docs:document.media:upload",
    "space:document:retrieve",
)
TOKEN = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
OPERATION = re.compile(r"[A-Za-z0-9_-]{8,128}\Z")
SPACE = re.compile(r"[0-9]{1,30}\Z")
TASK = re.compile(r"[A-Za-z0-9_-]{1,256}\Z")
MOVE_RECOVERY_SECONDS = 15 * 60
MOVE_MAX_POSTS = 5
MOVE_BACKOFF = (1, 2, 4, 8, 15, 30)


class HostError(Exception):
    def __init__(self, message, code="HOST_ERROR", uncertain=False, transient=False, retryable=False,
                 retry_after_seconds=None):
        super().__init__(message)
        self.code, self.uncertain = code, uncertain
        self.transient, self.retryable = transient, retryable
        self.retry_after_seconds = retry_after_seconds

    def response(self):
        result = {"ok": False, "error": str(self), "code": self.code}
        if self.uncertain:
            result["uncertain"] = True
        if self.retryable:
            result["retryable"] = True
        return result


def identifier(value, name="标识", pattern=TOKEN):
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise HostError(name + "格式无效。", "INVALID_PARAMS")
    return value


def text_field(value, maximum=4096):
    return value if isinstance(value, str) and len(value) <= maximum else ""


def page_token(value):
    if not isinstance(value, str) or len(value) > 2048 or any(ord(c) < 32 for c in value):
        raise HostError("分页标识格式无效。", "INVALID_PARAMS")
    return value


def safe_url(value, authorization=False):
    if not isinstance(value, str) or len(value) > 8192 or any(ord(c) < 32 for c in value):
        return ""
    try:
        parsed = urlsplit(value)
        host = parsed.hostname or ""
        allowed = ("feishu.cn", "larksuite.com", "larkoffice.com")
        if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443):
            return ""
        if not any(host == item or host.endswith("." + item) for item in allowed):
            return ""
        if {key.lower() for key in parse_qs(parsed.query)} & {"access_token", "refresh_token", "client_secret", "device_code"}:
            return ""
        if not authorization and (parsed.query or parsed.fragment):
            return ""
        return value
    except ValueError:
        return ""


def clean_node(node):
    if not isinstance(node, dict):
        raise HostError("飞书未返回有效节点信息。", "INVALID_RESPONSE")
    out = {}
    for key in ("space_id", "node_token", "obj_token", "obj_type", "parent_node_token",
                "node_type", "origin_node_token", "origin_space_id", "title"):
        if key in node:
            out[key] = text_field(node[key])
    if isinstance(node.get("has_child"), bool):
        out["has_child"] = node["has_child"]
    return out


def clean_space(space):
    if not isinstance(space, dict):
        raise HostError("飞书未返回有效知识库信息。", "INVALID_RESPONSE")
    return {key: text_field(space[key]) for key in
            ("space_id", "name", "space_type", "visibility", "open_sharing") if key in space}


def clean_file(file):
    if not isinstance(file, dict):
        raise HostError("飞书未返回有效副本信息。", "INVALID_RESPONSE", uncertain=True)
    token = identifier(file.get("token"), "副本文档标识")
    if file.get("type") != "docx":
        raise HostError("飞书返回的副本类型不符，请检查云空间。", "INVALID_RESPONSE", uncertain=True)
    return {"token": token, "name": text_field(file.get("name")), "type": "docx",
            "url": safe_url(file.get("url")) or "https://www.feishu.cn/docx/" + token}


def parse_json(raw):
    if not isinstance(raw, (str, bytes)) or len(raw) > MAX_MESSAGE:
        return None
    try:
        value = json.loads(raw)
        return value if isinstance(value, dict) else None
    except (ValueError, UnicodeError):
        return None


def run_cli_process(argv, capture_output=True, text=True, timeout=CLI_TIMEOUT, check=False, cwd=None):
    """Kill the entire CLI process group on timeout (npm may launch a child binary)."""
    with subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=text, start_new_session=True, cwd=cwd) as process:
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate()
            raise subprocess.TimeoutExpired(argv, timeout)
        return subprocess.CompletedProcess(argv, process.returncode, stdout, stderr)


def cli_error(stdout, stderr, returncode, write=False):
    """Classify known errors; never return CLI messages, hints, or raw output."""
    obj = parse_json(stderr) or parse_json(stdout) or {}
    err = obj.get("error", {})
    if not isinstance(err, dict):
        err = {}
    error_type = err.get("type")
    subtype = err.get("subtype")
    raw_code = obj.get("code", err.get("code"))
    if raw_code is None and isinstance(err.get("details"), dict):
        raw_code = err["details"].get("code")
    code = str(raw_code) if isinstance(raw_code, (int, str)) and re.fullmatch(r"[0-9]{1,12}", str(raw_code)) else "CLI_ERROR"
    # Inspection is local only. Text is used to classify, never exposed.
    lower = json.dumps(obj, ensure_ascii=False).lower()
    if error_type == "confirmation_required" or returncode == 10:
        return HostError("飞书 CLI 要求额外确认，此操作未继续。", "CONFIRMATION_REQUIRED")
    if error_type == "validation":
        return HostError("飞书 CLI 本地参数或文件检查未通过，请检查本机连接器；请求尚未发送。", "CLI_VALIDATION")
    if code in ("99991679", "99991672") or "scope" in lower and any(x in lower for x in ("permission", "missing", "denied", "insufficient", "not granted")):
        return HostError("飞书授权缺少所需权限，请重新点击登录并授权；若仍失败，请在应用后台开通本功能权限。", "MISSING_SCOPE")
    if error_type == "authentication" or returncode == 3 or code in ("99991663", "99991668", "99991671", "1061005", "20037", "20064", "20073"):
        return HostError("飞书登录已失效或尚未登录，请重新登录并完成授权。", "AUTH_REQUIRED")
    if error_type == "config" or subtype == "not_configured":
        return HostError("尚未配置飞书 CLI，请先在终端完成 lark-cli config init。", "NOT_CONFIGURED")
    if code in ("1061004", "131006", "91204", "1770032") or error_type == "permission":
        return HostError("当前账户无法访问请求的文档，或没有目标位置编辑权限，请检查飞书中的权限。", "PERMISSION_DENIED")
    if code in ("1064510", "1064511"):
        return HostError("飞书不支持此次跨地域或跨品牌复制，请使用受支持的文档与目标。", code)
    if code in ("1061003", "1061007", "131005", "1063005"):
        return HostError("文档或知识库不存在，或当前登录用户无法访问。", "NOT_FOUND")
    if code in ("1061045", "1063006", "99991400", "131009"):
        delay = err.get("retry_after_seconds", obj.get("retry_after_seconds"))
        delay = delay if type(delay) in (int, float) and 0 < delay <= 86400 else None
        return HostError("飞书正在限流或处理其他请求，进度已保留。", code, transient=True,
                         retry_after_seconds=delay)
    if code in ("1771001", "1771002", "1771003", "1771004", "1771005", "131001"):
        return HostError("飞书服务暂时未完成请求，进度已保留。", code, write, transient=True)
    if code in ("1062507", "131003"):
        return HostError("目标位置已达到飞书节点数量限制，请选择其他位置。", code)
    if code == "1770041":
        return HostError("飞书拒绝了当前内容块的嵌套结构，请更新插件后继续当前任务；已有副本会保留。", code)
    if error_type in ("network", "transport", "timeout") or subtype in ("network_error", "request_timeout"):
        return HostError("飞书连接暂时中断，进度已保留。", "CLI_NETWORK", write, transient=True)
    if not obj:
        return HostError("飞书请求未返回可识别的结果，进度已保留。", "CLI_RESPONSE_ERROR", write, transient=True)
    if write:
        return HostError("本次写入暂未确认，进度已保留。", code, True)
    return HostError("飞书 CLI 请求失败，请检查本机 CLI 配置与授权后重试。", code)


class StateStore:
    def __init__(self, directory):
        self.directory = Path(directory)
        if not self.directory.is_absolute() or ".." in self.directory.parts:
            raise HostError("本机状态目录无效。", "STATE_ERROR")
        for path in [self.directory, *self.directory.parents]:
            if path.is_symlink():
                raise HostError("本机状态目录不能使用符号链接。", "STATE_ERROR")
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not self.directory.is_dir():
            raise HostError("本机状态目录不可用。", "STATE_ERROR")
        os.chmod(self.directory, 0o700)

    def file(self, name):
        path = self.directory / name
        if path.is_symlink() or path.exists() and not path.is_file():
            raise HostError("本机状态文件类型异常。", "STATE_ERROR")
        return path

    @contextlib.contextmanager
    def locked(self):
        path = self.file("host.lock")
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise HostError("另一个剪存请求正在执行，正在等待。", "BUSY", retryable=True)
            yield
        finally:
            os.close(fd)

    def read(self, name, default):
        path = self.file(name)
        if not path.exists():
            return default
        if path.stat().st_size > 8 * MAX_MESSAGE:
            raise HostError("本机状态记录过大，请检查安装目录。", "STATE_ERROR")
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except (ValueError, UnicodeError, OSError):
            raise HostError("本机恢复记录无法读取，为避免重复复制已停止。", "STATE_ERROR")

    def write(self, name, data):
        target = self.file(name)
        fd, filename = tempfile.mkstemp(prefix=".write-", dir=self.directory)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(data, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(filename, target)
            directory_fd = os.open(self.directory, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            if os.path.exists(filename):
                os.unlink(filename)  # This exact disposable file was created above.


class NativeHost:
    ACTION_PARAMS = {
        "status": (), "authorize_start": (), "authorize_finish": (),
        "list_spaces": ("page_token",), "get_space": ("space_id",),
        "list_nodes": ("space_id", "parent_node_token", "page_token"),
        "get_node": ("token", "obj_type"), "get_document": ("token",),
        "check_copy": ("token",), "copy_doc": ("token", "name", "operation_id"),
        "move_doc": ("space_id", "parent_node_token", "obj_token", "operation_id"),
        "get_task": ("task_id",),
        "prepare_content": ("token", "operation_id", "origin_url"),
        "prepare_web_content": ("operation_id", "source_url", "snapshot"),
        "refresh_web_content": ("operation_id", "source_url", "snapshot", "request_id"),
        "retry_content_creation": ("operation_id", "request_id"),
        "stage_image": ("operation_id", "block_id", "offset", "total_size", "mime_type", "data_base64", "pixel_width", "pixel_height"),
        "import_step": ("operation_id",),
        "get_operation": ("operation_id",),
    }

    def __init__(self, lark_cli, state_dir, runner=None):
        self.lark_cli = str(lark_cli)
        if not Path(self.lark_cli).is_absolute():
            raise HostError("飞书 CLI 必须使用安装时确认的绝对路径。", "CLI_UNAVAILABLE")
        self.store = StateStore(state_dir)
        self.runner = runner or run_cli_process
        spec = importlib.util.spec_from_file_location("feishu_content_import", Path(__file__).with_name("feishu_content_import.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.content = module.ContentImporter(self, HostError)

    def run(self, args, write=False, raw=False):
        try:
            result = self.runner([self.lark_cli, *args], capture_output=True,
                                 text=True, timeout=CLI_TIMEOUT, check=False,
                                 cwd=str(self.store.directory))
        except subprocess.TimeoutExpired:
            raise HostError("飞书请求超时，进度已保留。", "CLI_TIMEOUT", write,
                            transient=True, retryable=not write)
        except (FileNotFoundError, PermissionError):
            raise HostError("无法启动飞书 CLI，请重新安装本机连接器。", "CLI_UNAVAILABLE")
        except OSError:
            raise HostError("本机飞书 CLI 启动失败。", "CLI_UNAVAILABLE")
        if raw:
            if result.returncode:
                error = cli_error(result.stdout, result.stderr, result.returncode, write)
                error.retryable = error.transient and not write
                raise error
            return result.stdout
        value = parse_json(result.stdout)
        if result.returncode or value is None or value.get("ok") is False or value.get("code", 0) != 0:
            error = cli_error(result.stdout, result.stderr, result.returncode, write)
            error.retryable = error.transient and not write
            raise error
        # CLI 1.0.88 API success envelope / older raw OpenAPI response.
        if value.get("ok") is True or "code" in value:
            data = value.get("data", {})
            if isinstance(data, dict) and "code" in data:
                if data["code"] != 0:
                    error = cli_error(json.dumps(data), "", 0, write)
                    error.retryable = error.transient and not write
                    raise error
                data = data.get("data", {})
        else:
            data = value  # auth --no-wait emits a direct object.
        if not isinstance(data, dict):
            raise HostError("飞书 CLI 返回格式无法识别。", "INVALID_RESPONSE", write)
        return data

    def api(self, method, path, params=None, body=None):
        args = ["api", method, path, "--as", "user", "--format", "json"]
        if params:
            args += ["--params", json.dumps(params, ensure_ascii=False)]
        if body is not None:
            args += ["--data", json.dumps(body, ensure_ascii=False)]
        try:
            return self.run(args, write=method != "GET")
        except HostError as error:
            # A committed descendant/patch can be safely replayed only with the
            # same journaled UUID. Never apply this to document creation/moves.
            client_token = (params or {}).get("client_token")
            try:
                idempotent = method in ("POST", "PATCH") and uuid.UUID(client_token).version == 4
            except (ValueError, TypeError, AttributeError):
                idempotent = False
            if error.transient and (idempotent or not error.uncertain):
                error.retryable = True
            if error.code == "MISSING_SCOPE":
                scope = ("docs:document:copy" if path.endswith("/copy") else
                         "docx:document:create" if method == "POST" and path == "/open-apis/docx/v1/documents" else
                         "docx:document:write_only" if method != "GET" and "/docx/" in path else
                         "docs:document.media:upload" if path.endswith("/medias/upload_all") else
                         "wiki:node:move" if path.endswith("/move_docs_to_wiki") else
                         "space:document:retrieve" if method == "GET" and path == "/open-apis/drive/v1/files" else
                         "docx:document:write_only" if method == "PATCH" and path.startswith("/open-apis/drive/v1/files/") else
                         "docs:permission.member:auth" if path.endswith("/members/auth") else
                         "drive:drive.metadata:readonly" if path.endswith("/root_folder/meta") else
                         "docx:document:readonly" if "/docx/" in path else
                         "wiki:node:read" if path.endswith("/get_node") else
                         "wiki:node:retrieve" if path.endswith("/nodes") else
                         "wiki:space:retrieve" if path.endswith("/spaces") else "wiki:space:read")
                raise HostError("飞书缺少权限 " + scope + "，请重新点击登录并授权；必要时先在应用后台开通该权限。", "MISSING_SCOPE")
            raise

    def handle(self, message):
        try:
            if not isinstance(message, dict) or set(message) - {"action", "params"}:
                raise HostError("请求格式无效。", "INVALID_REQUEST")
            action, params = message.get("action"), message.get("params", {})
            if not isinstance(action, str) or action not in self.ACTION_PARAMS:
                raise HostError("不支持此操作。", "UNKNOWN_ACTION")
            if not isinstance(params, dict) or set(params) - set(self.ACTION_PARAMS[action]):
                raise HostError("请求参数无效。", "INVALID_PARAMS")
            with self.store.locked():
                try:
                    data = self.dispatch(action, params)
                except HostError as error:
                    self.record_failure(action, params, error)
                    raise
            return {"ok": True, "data": data}
        except HostError as error:
            return error.response()
        except Exception:
            return HostError("本机连接器发生错误，恢复记录已保留，请勿重复创建副本。", "HOST_ERROR").response()

    def record_failure(self, action, params, error):
        """Keep a bounded, credential-free history under the existing lock."""
        if action == "get_operation":
            return  # Inspecting an old job must not change its journal.
        operation = params.get("operation_id")
        if not isinstance(operation, str) or not OPERATION.fullmatch(operation):
            return
        journal = self.store.read("operations.json", {})
        record = journal.get(operation)
        if not isinstance(record, dict):
            return
        # An uncertain bookmark append recovers by reading its exact position;
        # the importer never sends it a second time while bookmark_pending.
        if (action == "import_step" and error.transient and record.get("copied_token")
                and record.get("stage") == "content_bookmarks"):
            error.retryable = True
        failure = {"action": action, "phase": record.get("stage", ""), "code": error.code,
                   "uncertain": bool(error.uncertain), "retryable": bool(error.retryable),
                   "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        record["last_error"] = failure
        record["error_history"] = (record.get("error_history", []) + [failure])[-20:]
        self.store.write("operations.json", journal)

    def dispatch(self, action, params):
        if action == "get_operation":
            return self.get_operation(params)
        if action == "prepare_content":
            return self.content.prepare(params)
        if action == "prepare_web_content":
            return self.content.prepare_web(params)
        if action == "refresh_web_content":
            return self.content.refresh_web(params)
        if action == "retry_content_creation":
            return self.content.retry_creation(params)
        if action == "stage_image":
            return self.content.stage_image(params)
        if action == "import_step":
            return self.content.step(params)
        if action == "status":
            version = self.run(["--version"], raw=True)
            match = re.search(r"\b\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?\b", version[:256])
            return {"available": True, "version": match.group(0) if match else "unknown", "host": HOST_NAME}
        if action == "authorize_start":
            data = self.run(["auth", "login", "--scope", " ".join(SCOPES), "--no-wait", "--json"])
            url = safe_url(data.get("verification_url"), authorization=True)
            device = data.get("device_code")
            expiry = data.get("expires_in")
            if not url or not isinstance(device, str) or not 1 <= len(device) <= 8192 or any(ord(c) < 32 for c in device):
                raise HostError("飞书未返回有效授权链接，请重试登录。", "AUTH_RESPONSE_INVALID")
            if not isinstance(expiry, (int, float)) or isinstance(expiry, bool) or not 1 <= expiry <= 3600:
                expiry = 240
            self.store.write("authorization.json", {"device_code": device, "expires_at": time.time() + expiry})
            return {"verification_url": url}
        if action == "authorize_finish":
            auth = self.store.read("authorization.json", {})
            if not isinstance(auth.get("device_code"), str) or auth.get("expires_at", 0) <= time.time():
                raise HostError("授权请求已过期，请重新点击登录。", "AUTH_EXPIRED")
            data = self.run(["auth", "login", "--device-code", auth["device_code"], "--json"])
            if data.get("event") != "authorization_complete" or data.get("missing"):
                raise HostError("飞书授权尚未完成或权限不完整，请完成授权后再试。", "AUTH_INCOMPLETE")
            self.store.write("authorization.json", {})
            return {"authorized": True}
        if action == "list_spaces":
            query = {"page_size": 50}
            if "page_token" in params:
                query["page_token"] = page_token(params["page_token"])
            return self.clean_page(self.api("GET", "/open-apis/wiki/v2/spaces", query), clean_space)
        if action == "get_space":
            space = params.get("space_id")
            if space != "my_library":
                identifier(space, "知识库标识", SPACE)
            return {"space": clean_space(self.api("GET", "/open-apis/wiki/v2/spaces/" + space, {"lang": "zh"}).get("space"))}
        if action == "list_nodes":
            space = identifier(params.get("space_id"), "知识库标识", SPACE)
            query = {"page_size": 50}
            if "parent_node_token" in params:
                parent = params["parent_node_token"]
                if parent == "":
                    pass
                else:
                    query["parent_node_token"] = identifier(parent, "父页面标识")
            if "page_token" in params:
                query["page_token"] = page_token(params["page_token"])
            return self.clean_page(self.api("GET", "/open-apis/wiki/v2/spaces/" + space + "/nodes", query), clean_node)
        if action == "get_node":
            token = identifier(params.get("token"))
            kind = params.get("obj_type", "wiki")
            if kind not in ("wiki", "docx"):
                raise HostError("仅支持飞书新版文档和知识库页面。", "INVALID_PARAMS")
            return {"node": clean_node(self.api("GET", "/open-apis/wiki/v2/spaces/get_node", {"token": token, "obj_type": kind}).get("node"))}
        if action == "get_document":
            token = identifier(params.get("token"))
            doc = self.api("GET", "/open-apis/docx/v1/documents/" + token).get("document")
            if not isinstance(doc, dict):
                raise HostError("飞书未返回文档信息。", "INVALID_RESPONSE")
            out = {key: text_field(doc[key]) for key in ("document_id", "title") if key in doc}
            if isinstance(doc.get("revision_id"), int):
                out["revision_id"] = doc["revision_id"]
            return {"document": out}
        if action == "check_copy":
            return self.check_copy(identifier(params.get("token")))
        if action == "copy_doc":
            return self.copy_doc(params)
        if action == "move_doc":
            return self.move_doc(params)
        if action == "get_task":
            return self.get_task(identifier(params.get("task_id"), "任务标识", TASK))
        raise HostError("不支持此操作。", "UNKNOWN_ACTION")

    @staticmethod
    def clean_page(data, cleaner):
        items = data.get("items", [])
        if not isinstance(items, list) or len(items) > 100:
            raise HostError("飞书分页响应格式无效。", "INVALID_RESPONSE")
        out = {"items": [cleaner(item) for item in items], "has_more": data.get("has_more") is True}
        if data.get("page_token"):
            out["page_token"] = page_token(data["page_token"])
        return out

    def check_copy(self, token):
        data = self.api("GET", "/open-apis/drive/v1/permissions/" + token + "/members/auth",
                        {"type": "docx", "action": "copy"})
        if not isinstance(data.get("auth_result"), bool):
            raise HostError("无法确认文档复制权限。", "INVALID_RESPONSE")
        return {"auth_result": data["auth_result"]}

    def copy_doc(self, params):
        source = identifier(params.get("token"), "源文档标识")
        operation = identifier(params.get("operation_id"), "剪存操作标识", OPERATION)
        name = params.get("name")
        if not isinstance(name, str) or not name.strip() or len(name.encode("utf-8")) > 256 or any(ord(c) < 32 for c in name):
            raise HostError("文档标题不能为空，且不得超过 256 字节。", "INVALID_PARAMS")
        journal = self.store.read("operations.json", {})
        record = journal.get(operation)
        if record:
            if record.get("source") != source or record.get("name") != name:
                raise HostError("剪存操作标识已用于其他文档。", "OPERATION_CONFLICT")
            if record.get("file"):
                return {"file": clean_file(record["file"])}
            if record.get("stage") != "copy_failed":
                raise HostError("此前复制结果尚未确认，请检查云空间，勿重复创建副本。", "COPY_UNCERTAIN", True)
        if not self.check_copy(source)["auth_result"]:
            raise HostError("作者未允许当前用户创建副本，请先获得文档复制权限。", "COPY_FORBIDDEN")
        root = self.api("GET", "/open-apis/drive/explorer/v2/root_folder/meta")
        folder = identifier(root.get("token"), "云空间根目录标识")
        if len(journal) >= 10000:
            raise HostError("本机恢复记录已达到上限，请检查连接器记录。", "STATE_FULL")
        record = {"source": source, "name": name, "stage": "copy_pending", "created_at": time.time()}
        journal[operation] = record
        self.store.write("operations.json", journal)  # Persist intent before the non-idempotent POST.
        try:
            data = self.api("POST", "/open-apis/drive/v1/files/" + source + "/copy",
                            body={"name": name, "type": "docx", "folder_token": folder})
            try:
                file = clean_file(data.get("file"))
            except HostError:
                raise HostError("飞书未返回有效副本，结果尚未确认，请检查云空间。", "COPY_UNCERTAIN", True)
            if file["token"] == source:
                raise HostError("飞书未返回独立副本，已停止迁入。", "COPY_UNCERTAIN", True)
        except HostError as error:
            record["stage"] = "copy_uncertain" if error.uncertain else "copy_failed"
            record["error_code"] = error.code
            self.store.write("operations.json", journal)
            raise
        record.update({"copied_token": file["token"], "file": file, "stage": "copied"})
        self.store.write("operations.json", journal)
        return {"file": file}

    def get_operation(self, params):
        """Read a filtered journal summary without replaying any remote write.

        A browser can lag behind a task recovered through another extension
        instance. This is evidence for reconciliation, not a completion claim:
        the caller must match the saved source/copy/target and read the live wiki
        node before showing success. No body, images, CLI output or auth state
        leaves the host.
        """
        operation = identifier(params.get("operation_id"), "剪存操作标识", OPERATION)
        record = self.store.read("operations.json", {}).get(operation)
        if not isinstance(record, dict) or record.get("mode") != "content":
            return {"found": False}
        source = identifier(record.get("source"), "源文档标识")
        result = {"found": True, "source_token": source,
                  "phase": record.get("stage", ""),
                  "content_verified": record.get("content_verified") is True}
        if record.get("source_url"):
            result["source_url"] = self.content.web_url(record["source_url"])
        if record.get("copied_token"):
            token = identifier(record["copied_token"], "副本文档标识")
            if token == source:
                raise HostError("恢复记录的副本标识无效。", "STATE_ERROR")
            result["document"] = {"token": token}
        if record.get("target"):
            target = record["target"]
            result["target"] = {
                "space_id": identifier(target.get("space_id"), "知识库标识", SPACE),
                "parent_node_token": identifier(target["parent_node_token"], "父页面标识") if target.get("parent_node_token") else ""}
        if record.get("stage") == "moved" and record.get("move_result", {}).get("wiki_token"):
            result["wiki_token"] = identifier(record["move_result"]["wiki_token"], "知识库页面标识")
        if (record.get("stage") in ("move_pending", "move_uncertain", "moving")
                and result.get("document") and result.get("target") and result["content_verified"]):
            state = record.get("move_recovery", {})
            stopped = bool(state.get("stopped_code")) or record.get("last_error", {}).get("code") in (
                "PERMISSION_DENIED", "AUTH_REQUIRED", "MISSING_SCOPE", "TARGET_MISMATCH", "TARGET_CONFLICT", "MOVE_FAILED")
            result["move_recovery"] = {"recoverable": not stopped and time.time() < state.get("deadline", float("inf")),
                                       "post_attempts": state.get("post_attempts", 1)}
            for local, public in (("deadline", "deadline"), ("next_run_at", "deferred_until")):
                if type(state.get(local)) in (int, float):
                    result["move_recovery"][public] = int(state[local] * 1000)
            if record.get("task_id"):
                result["task_id"] = identifier(record["task_id"], "任务标识", TASK)
        return result

    def move_recovery_state(self, record):
        state = record.get("move_recovery")
        if not isinstance(state, dict):
            now = time.time()
            state = {"started_at": now, "deadline": now + MOVE_RECOVERY_SECONDS,
                     "next_run_at": 0, "checks": 0,
                     "post_attempts": int(record.get("stage") in ("move_pending", "move_uncertain", "moving")),
                     "post_forbidden": record.get("error_code") == "131007"}
            record["move_recovery"] = state
        return state

    def defer_move(self, journal, record, error=None):
        state = self.move_recovery_state(record)
        now = time.time()
        if error:
            record["error_code"] = error.code
            failure = {"action": "move_doc", "phase": record["stage"], "code": error.code,
                       "uncertain": bool(error.uncertain), "retryable": bool(error.retryable),
                       "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            record["last_error"] = failure
            record["error_history"] = (record.get("error_history", []) + [failure])[-20:]
            if error.code == "131007":
                state["post_forbidden"] = True
        if now >= state["deadline"]:
            state["next_run_at"] = state["deadline"]
            self.store.write("operations.json", journal)
            raise HostError("飞书暂未确认迁入结果，已保存的文档和恢复记录已保留。", "MOVE_UNCERTAIN", True)
        delay = MOVE_BACKOFF[min(state["checks"], len(MOVE_BACKOFF) - 1)]
        if error and error.retry_after_seconds is not None:
            delay = max(delay, error.retry_after_seconds)
        state.update({"checks": state["checks"] + 1, "next_run_at": min(now + delay, state["deadline"])})
        self.store.write("operations.json", journal)
        return {"recovering": True, "deferred_until": int(state["next_run_at"] * 1000)}

    def accept_move_node(self, journal, record, node):
        node = clean_node(node)
        target = record["target"]
        if (node.get("obj_type") != "docx" or node.get("node_type", "origin") != "origin"
                or node.get("obj_token") != record["copied_token"]
                or node.get("space_id") != target["space_id"]
                or node.get("parent_node_token", "") != target["parent_node_token"]):
            raise HostError("副本当前位置与目标不一致，请检查副本。", "TARGET_MISMATCH")
        wiki = identifier(node.get("node_token"), "知识库页面标识")
        record.update({"stage": "moved", "move_result": {"wiki_token": wiki}})
        record.pop("last_error", None)
        record.pop("error_code", None)
        self.store.write("operations.json", journal)
        return record["move_result"]

    def move_doc(self, params):
        operation = identifier(params.get("operation_id"), "剪存操作标识", OPERATION)
        copied = identifier(params.get("obj_token"), "副本文档标识")
        space = identifier(params.get("space_id"), "知识库标识", SPACE)
        parent = params.get("parent_node_token", "")
        if parent:
            identifier(parent, "父页面标识")
        elif not isinstance(parent, str):
            raise HostError("父页面标识格式无效。", "INVALID_PARAMS")
        journal = self.store.read("operations.json", {})
        record = journal.get(operation)
        if not isinstance(record, dict) or copied != record.get("copied_token") or copied == record.get("source"):
            raise HostError("只能迁入本次剪存创建的副本，原文档和未知文档不会被移动。", "MOVE_FORBIDDEN")
        if record.get("mode") == "content" and record.get("content_verified") is not True:
            raise HostError("新文档内容尚未完整核对，请先继续内容剪存。", "CONTENT_NOT_VERIFIED")
        target = {"space_id": space, "parent_node_token": parent}
        if record.get("target") and record["target"] != target:
            raise HostError("本次副本已绑定其他目标，请先检查已有迁入结果。", "TARGET_CONFLICT")
        if record.get("stage") == "moved" and record.get("move_result", {}).get("wiki_token"):
            return record["move_result"]
        recovering = record.get("stage") in ("move_pending", "move_uncertain", "moving", "move_failed")
        state = self.move_recovery_state(record)
        record["target"] = target
        # Persist the initial deadline before any request, including old journals.
        self.store.write("operations.json", journal)
        now = time.time()
        if now >= state["deadline"]:
            raise HostError("飞书暂未确认迁入结果，已保存的文档和恢复记录已保留。", "MOVE_UNCERTAIN", True)
        if state["next_run_at"] > now:
            return {"recovering": True, "deferred_until": int(state["next_run_at"] * 1000)}
        if recovering:
            # GET accepts the actual document token, not only a wiki token:
            # https://open.feishu.cn/document/server-docs/docs/wiki-v2/space-node/get_node
            # An absent node is NOT proof that the first POST was never sent.
            try:
                node = self.api("GET", "/open-apis/wiki/v2/spaces/get_node",
                                {"token": copied, "obj_type": "docx"}).get("node")
                return self.accept_move_node(journal, record, node)
            except HostError as error:
                if error.code != "NOT_FOUND":
                    if error.transient or error.code in ("INVALID_RESPONSE", "131007"):
                        return self.defer_move(journal, record, error)
                    raise
            task_id = record.get("task_id") or record.get("move_result", {}).get("task_id")
            if task_id:
                task_id = identifier(task_id, "任务标识", TASK)
                # Restore legacy journals that retained only the response envelope.
                record["task_id"] = task_id
                self.store.write("operations.json", journal)
                try:
                    result = self.get_task(task_id)["task"]["move_result"][0]
                except HostError as error:
                    if error.transient or error.code in ("INVALID_RESPONSE", "NOT_FOUND", "131007"):
                        return self.defer_move(journal, record, error)
                    raise
                journal = self.store.read("operations.json", {})
                record = journal[operation]
                state = record["move_recovery"]
                if result["status"] == 0:
                    record.pop("last_error", None)
                    record.pop("error_code", None)
                    self.store.write("operations.json", journal)
                    return record["move_result"]
                if result["status"] == 1:
                    return self.defer_move(journal, record)
                # The preceding doc-token lookup already checked 'already in wiki'.
                # A known task failure is actionable, not an automatic POST retry.
                record.pop("task_id", None)
                record.pop("move_result", None)
                record["stage"] = "move_failed"
                self.store.write("operations.json", journal)
                raise HostError("飞书未能迁入当前文档，请检查目标权限与节点限制后继续。", "MOVE_FAILED")
            if state["post_forbidden"]:
                state["stopped_code"] = "131007"
                self.store.write("operations.json", journal)
                raise HostError("飞书返回不能重复请求的内部错误，文档已保留；请联系飞书支持检查迁入结果。", "131007", True)
            if state["post_attempts"] >= MOVE_MAX_POSTS:
                return self.defer_move(journal, record)
        # Validate the parent again before replaying the immutable operation.
        if parent:
            try:
                node = clean_node(self.api("GET", "/open-apis/wiki/v2/spaces/get_node",
                                           {"token": parent}).get("node"))
                if node.get("space_id") != space or node.get("node_token") != parent:
                    raise HostError("目标父页面不属于所选知识库。", "TARGET_MISMATCH")
            except HostError as error:
                if error.transient or error.code in ("INVALID_RESPONSE", "131007"):
                    return self.defer_move(journal, record, error)
                raise
        # Unlike document creation, this API moves the SAME known obj_token.
        # Its documented response returns an existing wiki token when the document
        # is already in Wiki, so a lost response can be replayed after reconciliation.
        # Never retry 131007: the official endpoint explicitly forbids that retry.
        # https://open.feishu.cn/document/server-docs/docs/wiki-v2/task/move_docs_to_wiki
        if time.time() >= state["deadline"]:
            return self.defer_move(journal, record)
        record["stage"] = "move_pending"
        state["post_attempts"] += 1
        self.store.write("operations.json", journal)
        try:
            data = self.api("POST", "/open-apis/wiki/v2/spaces/" + space + "/nodes/move_docs_to_wiki",
                            body={"obj_type": "docx", "obj_token": copied, "parent_wiki_token": parent, "apply": False})
            try:
                if data.get("wiki_token"):
                    result = {"wiki_token": identifier(data["wiki_token"], "知识库页面标识")}
                elif data.get("task_id"):
                    result = {"task_id": identifier(data["task_id"], "任务标识", TASK)}
                else:
                    raise HostError("未返回任务标识")
            except HostError:
                raise HostError("飞书未返回可核对的迁入结果，正在核对副本当前位置。", "MOVE_UNCERTAIN", True)
        except HostError as error:
            record["stage"] = "move_uncertain" if error.uncertain else "move_failed"
            record["error_code"] = error.code
            self.store.write("operations.json", journal)
            if error.uncertain or error.transient:
                return self.defer_move(journal, record, error)
            raise
        record.update({"move_result": result, "stage": "moving"})
        record.pop("last_error", None)
        record.pop("error_code", None)
        if "task_id" in result:
            record["task_id"] = result["task_id"]
            state["next_run_at"] = min(time.time() + 1, state["deadline"])
        else:
            # A POST token is only a candidate until get_node confirms the parent.
            state["next_run_at"] = 0
        self.store.write("operations.json", journal)
        return result if "task_id" in result else {"recovering": True, "deferred_until": int(time.time() * 1000)}

    def get_task(self, task_id):
        journal = self.store.read("operations.json", {})
        record = next((r for r in journal.values() if isinstance(r, dict) and r.get("task_id") == task_id), None)
        if record is None:
            raise HostError("只能查询本机剪存创建的迁入任务。", "TASK_FORBIDDEN")
        data = self.api("GET", "/open-apis/wiki/v2/tasks/" + task_id, {"task_type": "move"})
        task = data.get("task")
        results = task.get("move_result") if isinstance(task, dict) else None
        if not isinstance(results, list) or len(results) != 1 or not isinstance(results[0], dict):
            raise HostError("飞书任务结果暂不可用，请稍后继续查询。", "INVALID_RESPONSE")
        item = results[0]
        status = item.get("status")
        if type(status) is not int or status not in (-1, 0, 1):
            raise HostError("飞书任务状态无法识别，请稍后继续查询。", "INVALID_RESPONSE")
        result = {"status": status, "status_msg": {0: "success", 1: "processing", -1: "迁入失败，请检查目标权限与节点限制"}[status]}
        if status == 0:
            node = clean_node(item.get("node"))
            target = record["target"]
            if node.get("obj_token") != record["copied_token"] or node.get("space_id") != target["space_id"]:
                raise HostError("返回的迁入位置与目标不一致，请检查副本。", "TARGET_MISMATCH")
            wiki_token = identifier(node.get("node_token"), "知识库页面标识")
            # The task result can contain an outdated empty parent. Resolve the
            # current node before reporting a verified destination to the UI.
            node = clean_node(self.api("GET", "/open-apis/wiki/v2/spaces/get_node",
                                       {"token": wiki_token, "obj_type": "wiki"}).get("node"))
            if (node.get("node_token") != wiki_token or node.get("obj_type") != "docx"
                    or node.get("node_type", "origin") != "origin"
                    or node.get("obj_token") != record["copied_token"]
                    or node.get("space_id") != target["space_id"]
                    or node.get("parent_node_token", "") != target["parent_node_token"]):
                raise HostError("副本当前位置与目标不一致，请检查副本。", "TARGET_MISMATCH")
            result["node"] = node
            record.update({"stage": "moved", "move_result": {"wiki_token": node["node_token"]}})
            record.pop("last_error", None)
            record.pop("error_code", None)
        elif status == -1:
            record["stage"] = "move_failed"
            record.pop("move_result", None)  # A user resume may retry this known failed move of the same copy.
            record.pop("task_id", None)
            if isinstance(record.get("move_recovery"), dict):
                record["move_recovery"]["next_run_at"] = 0
        self.store.write("operations.json", journal)
        return {"task": {"task_id": task_id, "move_result": [result]}}


def read_exact(stream, size):
    chunks, remaining = [], size
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def serve(host, source, target):
    while True:
        header = read_exact(source, 4)
        if not header:
            return
        if len(header) != 4:
            return
        size = struct.unpack("=I", header)[0]
        if not 0 < size <= MAX_MESSAGE:
            response = HostError("请求长度超出限制。", "MESSAGE_TOO_LARGE").response()
            done = True
        else:
            raw = read_exact(source, size)
            if len(raw) != size:
                return
            message = parse_json(raw)
            response = host.handle(message)
            done = False
        encoded = json.dumps(response, ensure_ascii=False, allow_nan=False).encode("utf-8")
        if len(encoded) > MAX_MESSAGE:
            encoded = json.dumps(HostError("响应长度超出限制。", "RESPONSE_TOO_LARGE").response()).encode()
        target.write(struct.pack("=I", len(encoded)))
        target.write(encoded)
        target.flush()
        if done:
            return


def main():
    parser = argparse.ArgumentParser(description="Feishu clipper Native Messaging host")
    parser.add_argument("--lark-cli", required=True)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--allowed-origin", required=True)
    parser.add_argument("origin", nargs="?")
    args = parser.parse_args()
    if args.origin != args.allowed_origin:
        return 1
    try:
        host = NativeHost(args.lark_cli, args.state_dir)
        serve(host, sys.stdin.buffer, sys.stdout.buffer)
    except Exception:
        return 1  # Native stdout is protocol only; never print an exception or credentials.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
