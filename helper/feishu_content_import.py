"""Rebuild readable Feishu documents from public blocks and locally staged images.

Only the host can select API paths and destination documents. Browser article
snapshots pass a separate strict schema before becoming an import plan. Each
import step performs at most one remote request, and only edits the newly created
destination document. The host never downloads browser-supplied article URLs.
"""

import base64
import copy
import hashlib
import json
import os
import re
import struct
import time
import uuid
from urllib.parse import unquote, urlsplit
import xml.etree.ElementTree as ET


TEXT_FIELDS = {2: "text", **{n + 2: "heading" + str(n) for n in range(1, 10)},
               12: "bullet", 13: "ordered", 14: "code", 15: "quote", 17: "todo"}
OTHER_FIELDS = {19: "callout", 22: "divider", 24: "grid", 25: "grid_column",
                27: "image", 31: "table", 32: "table_cell", 34: "quote_container"}
MAX_IMAGE = 20 * 1024 * 1024
MAX_CHUNK = 512 * 1024
MAX_WEB_SNAPSHOT = 700 * 1024
WEB_ROOT = "WebRoot"
CREATE_MARKER_PREFIX = "飞书剪存-"
CREATE_RECOVERY_SECONDS = 300
MIMES = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
         "image/webp": ".webp", "image/bmp": ".bmp"}


def stripped(value):
    if isinstance(value, dict):
        return {key: stripped(item) for key, item in value.items() if key != "comment_ids"}
    if isinstance(value, list):
        return [stripped(item) for item in value]
    return value


def digest(stream):
    result = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        result.update(chunk)
    return result.hexdigest()


def rewrite_internal_url(value, source, mapping, destination):
    """Only redirect known document-local anchors; preserve every other URL."""
    if not isinstance(value, str) or len(value) > 8192 or any(ord(char) < 32 for char in value):
        return value
    try:
        parsed = urlsplit(value)
        anchor = unquote(parsed.fragment)
        if anchor not in mapping:
            return value
        local = value.startswith("#") and not parsed.scheme and not parsed.netloc and not parsed.path and not parsed.query
        host = parsed.hostname or ""
        official = host == "feishu.cn" or host.endswith(".feishu.cn")
        source_doc = (parsed.scheme == "https" and official and not parsed.username and not parsed.password
                      and parsed.port in (None, 443) and not parsed.query
                      and parsed.path.rstrip("/") == "/docx/" + source)
        if not (local or source_doc):
            return value
        return "https://www.feishu.cn/docx/" + destination + "#" + mapping[anchor]
    except ValueError:
        return value


def rewritten_elements(block, source, mapping, destination, origin_block_id=None):
    # Attribution always points back to the source, even when it includes a
    # known document-local anchor that ordinary body links should remap.
    if block.get("block_id") == origin_block_id:
        return None
    field = TEXT_FIELDS.get(block.get("block_type"))
    if field is None:
        return None
    original = block.get(field, {}).get("elements", [])
    elements = copy.deepcopy(original)
    changed = False
    for element in elements:
        run = element.get("text_run", {})
        link = run.get("text_element_style", {}).get("link")
        if not isinstance(link, dict) or not isinstance(link.get("url"), str):
            continue
        mapped = rewrite_internal_url(link["url"], source, mapping, destination)
        if mapped != link["url"]:
            link["url"], changed = mapped, True
    return elements if changed else None


def semantic_text_elements(elements):
    """Compare exact text/style spans while ignoring API-only run boundaries.

    Feishu splits multiline code runs and fills omitted boolean styles with
    false. These changes do not alter the content. All characters, whitespace,
    links and non-default styling remain part of the comparison.
    """
    if not isinstance(elements, list):
        raise ValueError("Invalid text elements")
    result = []
    booleans = {"bold", "italic", "strikethrough", "underline", "inline_code"}
    for element in stripped(elements):
        if not isinstance(element, dict) or set(element) != {"text_run"}:
            raise ValueError("Unsupported text element")
        run = element["text_run"]
        if (not isinstance(run, dict) or set(run) - {"content", "text_element_style"}
                or not isinstance(run.get("content"), str)):
            raise ValueError("Invalid text run")
        style = run.get("text_element_style", {})
        if not isinstance(style, dict) or any(type(value) is not bool for key, value in style.items() if key in booleans):
            raise ValueError("Invalid text style")
        style = {key: value for key, value in style.items() if key not in booleans or value is not False}
        content = run["content"]
        if not content:
            continue
        if result and result[-1]["style"] == style:
            result[-1]["content"] += content
        else:
            result.append({"content": content, "style": style})
    return result


def apply_block_defaults(block):
    """Materialize only documented defaults that Feishu omits in read responses.

    Missing table header flags mean false, not a lost setting. Keep explicit
    true values and every non-default field in the strict comparison.
    """
    kind = block.get("block_type")
    if kind == 31:
        field, child, defaults = "table", "property", {"header_row": False, "header_column": False}
    elif kind in TEXT_FIELDS:
        field, child, defaults = TEXT_FIELDS[kind], "style", {"align": 1, "done": False, "folded": False, "wrap": False}
    else:
        return
    payload = block.get(field)
    if not isinstance(payload, dict):
        raise ValueError("Invalid block payload")
    settings = payload.setdefault(child, {})
    if not isinstance(settings, dict):
        raise ValueError("Invalid block settings")
    for key, default in defaults.items():
        value = settings.setdefault(key, default)
        if type(value) is not type(default):
            raise ValueError("Invalid block default type")


class ContentImporter:
    def __init__(self, host, error_class):
        self.host, self.Error = host, error_class
        self.store = host.store

    def fail(self, message, code="IMPORT_ERROR", uncertain=False):
        raise self.Error(message, code, uncertain)

    def identifier(self, value, operation=False):
        pattern = r"[A-Za-z0-9_-]{8,128}" if operation else r"[A-Za-z0-9_-]{1,128}"
        if not isinstance(value, str) or not re.fullmatch(pattern, value):
            self.fail("内容剪存标识格式无效。", "INVALID_PARAMS")
        return value

    def plan_name(self, operation):
        return "content-" + self.identifier(operation, True) + ".json"

    def read(self, operation):
        journal = self.store.read("operations.json", {})
        record = journal.get(operation)
        if not isinstance(record, dict) or record.get("mode") != "content":
            self.fail("请先读取文档并准备剪存内容。", "IMPORT_NOT_PREPARED")
        plan = self.store.read(self.plan_name(operation), {})
        if not plan or plan.get("source") != record.get("source"):
            self.fail("本机内容快照不可用，请保留已有新文档并检查本机记录。", "STATE_ERROR")
        if record.get("snapshot_refresh", {}).get("pending"):
            plan = self.apply_snapshot_refresh(operation, journal, record)
        return journal, record, plan

    def save(self, operation, journal, plan):
        self.store.write(self.plan_name(operation), plan)
        self.store.write("operations.json", journal)

    def read_blocks(self, token):
        blocks, page, seen = [], "", set()
        for _ in range(20):
            query = {"page_size": 500}
            if page:
                query["page_token"] = page
            data = self.host.api("GET", "/open-apis/docx/v1/documents/" + token + "/blocks", query)
            items = data.get("items")
            if not isinstance(items, list):
                self.fail("飞书未返回完整文档块。", "INVALID_RESPONSE")
            blocks.extend(items)
            if not data.get("has_more"):
                return blocks
            page = data.get("page_token")
            if not isinstance(page, str) or not page or page in seen or len(page) > 2048:
                self.fail("飞书分页标识异常，未创建文档。", "INVALID_RESPONSE")
            seen.add(page)
        self.fail("文档超过本次剪存的 10000 块限制。", "IMPORT_TOO_LARGE")

    def read_bookmark(self, token, block_id):
        token, block_id = self.identifier(token), self.identifier(block_id)
        data = self.host.run(["docs", "+fetch", "--api-version", "v2", "--as", "user", "--doc", token,
                              "--scope", "range", "--start-block-id", block_id, "--end-block-id", block_id,
                              "--detail", "full", "--doc-format", "xml"])
        content = data.get("document", {}).get("content")
        if not isinstance(content, str) or len(content) > 32768 or "<!" in content:
            self.fail("链接卡片返回格式无效，未忽略原内容。", "UNSUPPORTED_CONTENT")
        try:
            fragment = ET.fromstring(content)
        except ET.ParseError:
            self.fail("链接卡片返回格式无效。", "INVALID_RESPONSE")
        children = list(fragment)
        if (fragment.tag != "fragment" or len(children) != 1 or children[0].tag != "bookmark"
                or children[0].get("id") != block_id or list(children[0])
                or set(children[0].attrib) - {"id", "name", "href"}):
            self.fail("文档包含暂未支持的特殊内容；已尝试新版文档接口，未省略该内容。", "UNSUPPORTED_CONTENT")
        node = children[0]
        name, href = node.get("name"), node.get("href")
        try:
            url = urlsplit(href or "")
            valid_url = (url.scheme in ("http", "https") and url.hostname and not url.username and not url.password)
        except ValueError:
            valid_url = False
        if (not isinstance(name, str) or not 1 <= len(name) <= 4096 or not isinstance(href, str)
                or len(href) > 8192 or any(ord(c) < 32 for c in href) or not valid_url):
            self.fail("原文链接卡片的标题或网址无效。", "UNSUPPORTED_CONTENT")
        return {"name": name, "href": href}

    def sanitize(self, blocks, source, bookmarks=None):
        bookmarks = bookmarks or {}
        by_id, clean, images = {}, {}, []
        for block in blocks:
            if not isinstance(block, dict):
                self.fail("源文档结构无效。", "INVALID_RESPONSE")
            block_id = self.identifier(block.get("block_id"))
            if block_id in by_id:
                self.fail("源文档包含重复块，请重新读取。", "INVALID_RESPONSE")
            by_id[block_id] = block
        root = by_id.get(source)
        if not root or root.get("block_type") != 1:
            self.fail("未找到源文档根块。", "INVALID_RESPONSE")
        for block_id, block in by_id.items():
            kind = block.get("block_type")
            if kind == 1:
                if block_id != source:
                    self.fail("源文档包含其他页面根块。", "UNSUPPORTED_CONTENT")
                continue
            field = TEXT_FIELDS.get(kind) or OTHER_FIELDS.get(kind)
            if kind == 999 and block_id in bookmarks and not block.get("children") and block_id in root.get("children", []):
                clean[block_id] = {"block_id": block_id, "block_type": 999, "undefined": {}}
                continue
            if field is None:
                self.fail("文档包含当前无法完整重建的资源块（类型 " + str(kind) + "），未创建不完整文档。", "UNSUPPORTED_CONTENT")
            payload = stripped(block.get(field, {}))
            if not isinstance(payload, dict):
                self.fail("源文档块内容格式无效。", "INVALID_RESPONSE")
            out = {"block_id": block_id, "block_type": kind, field: payload}
            if "children" in block:
                if not isinstance(block["children"], list):
                    self.fail("源文档层级格式无效。", "INVALID_RESPONSE")
                out["children"] = [self.identifier(item) for item in block["children"]]
            if kind in TEXT_FIELDS:
                elements = payload.get("elements", [])
                if not isinstance(elements, list) or any(not isinstance(e, dict) or set(e) != {"text_run"} for e in elements):
                    self.fail("文档包含暂不能完整重建的行内资源，未创建不完整文档。", "UNSUPPORTED_CONTENT")
                for element in elements:
                    run = element["text_run"]
                    if not isinstance(run, dict) or not isinstance(run.get("content"), str):
                        self.fail("源文档富文本内容无效。", "INVALID_RESPONSE")
            if kind == 27:
                image = {key: payload[key] for key in ("token", "width", "height", "align", "caption", "scale") if key in payload}
                self.identifier(image.get("token"))
                image.update({"block_id": block_id, "staged": False})
                images.append(image)
                out["image"] = {key: payload[key] for key in ("align", "caption") if key in payload}
            if kind == 31:
                prop = payload.get("property", {})
                if any(item.get("row_span", 1) != 1 or item.get("col_span", 1) != 1 for item in prop.get("merge_info", [])):
                    self.fail("文档含合并单元格，当前重建不能保证原表格布局；未创建不完整文档。", "UNSUPPORTED_CONTENT")
                out["table"] = {"property": {key: prop[key] for key in
                    ("row_size", "column_size", "column_width", "header_row", "header_column") if key in prop}}
            clean[block_id] = out
        # The editor can retain an empty quote container after its last line is
        # removed, but the creation API rejects a container with no child. Keep
        # that visible blank quote by giving it one empty paragraph.
        for block_id, block in list(clean.items()):
            if block["block_type"] == 34 and not block.get("children"):
                child = uuid.uuid5(uuid.NAMESPACE_URL, source + "/" + block_id + "/empty-quote").hex
                if child in by_id or child in clean:
                    self.fail("空引用框标识冲突，未创建文档。", "INVALID_RESPONSE")
                block["children"] = [child]
                clean[child] = {"block_id": child, "block_type": 2,
                                "text": {"elements": [{"text_run": {"content": ""}}], "style": {"align": 1}}}
        roots = root.get("children", [])
        seen = set()

        def subtree(block_id, depth=0):
            if depth > 100 or block_id in seen or block_id not in clean:
                self.fail("源文档层级不完整或包含循环，未创建文档。", "INVALID_RESPONSE")
            seen.add(block_id)
            tree = [clean[block_id]]
            for child in clean[block_id].get("children", []):
                tree.extend(subtree(child, depth + 1))
            return tree

        batches, current_ids, current_blocks, image_count = [], [], [], 0
        for root_id in roots:
            tree = subtree(root_id)
            if root_id in bookmarks:
                if current_blocks:
                    batches.append({"children_id": current_ids, "descendants": current_blocks, "client_token": str(uuid.uuid4())})
                    current_ids, current_blocks, image_count = [], [], 0
                batches.append({"children_id": [root_id], "bookmark": bookmarks[root_id]})
                continue
            count = sum(block["block_type"] == 27 for block in tree)
            if len(tree) > 1000 or count > 20:
                self.fail("单个嵌套区块超过飞书创建限制，未创建文档。", "IMPORT_TOO_LARGE")
            if current_blocks and (len(current_blocks) + len(tree) > 200 or image_count + count > 20):
                batches.append({"children_id": current_ids, "descendants": current_blocks, "client_token": str(uuid.uuid4())})
                current_ids, current_blocks, image_count = [], [], 0
            current_ids.append(root_id)
            current_blocks.extend(tree)
            image_count += count
        if current_blocks:
            batches.append({"children_id": current_ids, "descendants": current_blocks, "client_token": str(uuid.uuid4())})
        if len(seen) != len(clean):
            self.fail("源文档存在未读取完整的内容，未创建文档。", "INVALID_RESPONSE")
        return clean, roots, batches, images

    def add_origin_link(self, plan, url):
        """Add one verified attribution paragraph only while building a new plan."""
        if plan.get("origin_link"):
            return
        url = self.web_url(url)
        block_id = "ClipSource" + uuid.uuid4().hex
        while block_id in plan["blocks"]:
            block_id = "ClipSource" + uuid.uuid4().hex
        block = {"block_id": block_id, "block_type": 2, "text": {
            "elements": [
                {"text_run": {"content": "原文出处：" + urlsplit(url).hostname + " · "}},
                {"text_run": {"content": "查看原文", "text_element_style": {"link": {"url": url}}}}
            ], "style": {"align": 1}}}
        plan["blocks"][block_id] = block
        plan["roots"] = [block_id, *plan["roots"]]
        first = plan["batches"][0] if plan["batches"] else None
        if first and "descendants" in first and len(first["descendants"]) < 200:
            first["children_id"].insert(0, block_id)
            first["descendants"].insert(0, block)
        else:
            plan["batches"].insert(0, {"children_id": [block_id], "descendants": [block],
                                       "client_token": str(uuid.uuid4())})
        plan["origin_link"] = {"url": url, "block_id": block_id}

    def prepare(self, params):
        source = self.identifier(params.get("token"))
        operation = self.identifier(params.get("operation_id"), True)
        journal = self.store.read("operations.json", {})
        if operation in journal:
            record = journal[operation]
            if record.get("source") != source or record.get("mode") != "content" or record.get("source_url"):
                self.fail("操作标识已用于其他剪存，请保留原任务记录。", "OPERATION_CONFLICT")
            _, record, plan = self.read(operation)
            return self.summary(record, plan, operation)
        if len(journal) >= 10000:
            self.fail("本机恢复记录已达到上限。", "STATE_FULL")
        path = "/open-apis/docx/v1/documents/" + source
        before = self.host.api("GET", path).get("document", {})
        title = before.get("title")
        if not isinstance(title, str) or not 1 <= len(title) <= 800:
            self.fail("原文标题无效或超过飞书新建文档限制。", "INVALID_RESPONSE")
        blocks = self.read_blocks(source)
        bookmarks = {block["block_id"]: self.read_bookmark(source, block["block_id"])
                     for block in blocks if block.get("block_type") == 999}
        after = self.host.api("GET", path).get("document", {})
        if before.get("revision_id") != after.get("revision_id"):
            self.fail("读取时原文发生修改，请重新准备内容。", "SOURCE_CHANGED")
        clean, roots, batches, images = self.sanitize(blocks, source, bookmarks)
        plan = {"source": source, "title": title, "revision": before.get("revision_id"),
                "create_marker": CREATE_MARKER_PREFIX + str(uuid.uuid4()),
                "blocks": clean, "roots": roots, "batches": batches, "images": images,
                "batch_index": 0, "bindings": {}, "verified_blocks": [], "verify_page": "", "bookmarks": bookmarks}
        self.add_origin_link(plan, params.get("origin_url", "https://www.feishu.cn/docx/" + source))
        # Keep room for the eventual verification copy inside the state-file limit.
        if len(json.dumps(plan, ensure_ascii=False).encode("utf-8")) > 5 * 1024 * 1024:
            self.fail("源文档内容超过本机快照大小限制，未创建文档。", "IMPORT_TOO_LARGE")
        record = {"mode": "content", "source": source, "name": title, "stage": "content_prepared",
                  "block_count": len(clean) + 1, "image_count": len(images)}
        journal[operation] = record
        self.save(operation, journal, plan)
        return self.summary(record, plan, operation)

    def web_object(self, value, allowed, required=()):
        if not isinstance(value, dict) or set(value) - set(allowed) or set(required) - set(value):
            self.fail("网页快照字段无效，请重新读取网页。", "INVALID_PARAMS")

    def web_number(self, value, minimum=1, maximum=100000):
        if type(value) is not int or not minimum <= value <= maximum:
            self.fail("网页快照的数字字段无效。", "INVALID_PARAMS")

    def web_url(self, value, image=False, anchor=False):
        if not isinstance(value, str) or not value or any(ord(c) <= 32 for c in value) or "\\" in value:
            self.fail("网页快照的网址无效。", "INVALID_PARAMS")
        if image and value.startswith("data:"):
            match = re.fullmatch(r"data:(image/(?:png|jpeg|gif|webp|bmp));base64,([A-Za-z0-9+/]+={0,2})", value)
            if match:
                try:
                    data = base64.b64decode(match[2], validate=True)
                    if data and self.image_signature(data[:16], match[1]):
                        return value
                except (ValueError, TypeError):
                    pass
            self.fail("网页内嵌图片编码或类型无效。", "INVALID_PARAMS")
        if len(value) > 8192:
            self.fail("网页网址超过长度限制。", "INVALID_PARAMS")
        if anchor and value.startswith("#"):
            return value
        try:
            url = urlsplit(value)
            if anchor and url.scheme == "mailto" and url.path and not url.netloc:
                return value
            valid = (url.scheme in ("http", "https") and url.hostname and url.username is None and url.password is None
                     and (url.port is None or 1 <= url.port <= 65535))
        except ValueError:
            valid = False
        if not valid:
            self.fail("网页快照只接受不含账号密码的 HTTP/HTTPS 网址。", "INVALID_PARAMS")
        return value

    def web_text(self, payload):
        self.web_object(payload, ("elements", "style"), ("elements",))
        elements = payload["elements"]
        if not isinstance(elements, list) or not elements:
            self.fail("网页富文本内容无效。", "INVALID_PARAMS")
        for element in elements:
            self.web_object(element, ("text_run",), ("text_run",))
            run = element["text_run"]
            self.web_object(run, ("content", "text_element_style"), ("content",))
            if not isinstance(run["content"], str) or "\x00" in run["content"]:
                self.fail("网页富文本正文无效。", "INVALID_PARAMS")
            style = run.get("text_element_style", {})
            booleans = ("bold", "italic", "strikethrough", "underline", "inline_code")
            self.web_object(style, (*booleans, "text_color", "background_color", "link"))
            for key, value in style.items():
                if key in booleans and type(value) is not bool:
                    self.fail("网页文字样式无效。", "INVALID_PARAMS")
                if key in ("text_color", "background_color"):
                    self.web_number(value, 1, 17)
                if key == "link":
                    self.web_object(value, ("url",), ("url",))
                    self.web_url(value["url"], anchor=True)
        style = payload.get("style", {})
        self.web_object(style, ("align", "done", "folded", "wrap", "language", "sequence", "background_color"))
        for key, value in style.items():
            if key == "align":
                self.web_number(value, 1, 3)
            elif key == "language":
                self.web_number(value, 0, 1000)
            elif key in ("done", "folded", "wrap"):
                if type(value) is not bool:
                    self.fail("网页段落样式无效。", "INVALID_PARAMS")
            elif not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_#.-]{1,64}", value):
                self.fail("网页段落样式无效。", "INVALID_PARAMS")

    def web_blocks(self, blocks):
        if not isinstance(blocks, list) or not 2 <= len(blocks) <= 5000:
            self.fail("网页正文为空或超过 5000 块限制。", "IMPORT_TOO_LARGE")
        for block in blocks:
            if not isinstance(block, dict) or type(block.get("block_type")) is not int:
                self.fail("网页内容块类型无效。", "INVALID_PARAMS")
            kind = block["block_type"]
            field = TEXT_FIELDS.get(kind) or OTHER_FIELDS.get(kind)
            if kind != 1 and field is None:
                self.fail("网页包含当前无法重建的内容块。", "UNSUPPORTED_CONTENT")
            self.web_object(block, ("block_id", "block_type", "children", *([field] if field else [])),
                            ("block_id", "block_type", *([field] if field else ["children"])))
            self.identifier(block["block_id"])
            if "children" in block:
                if not isinstance(block["children"], list):
                    self.fail("网页层级结构无效。", "INVALID_PARAMS")
                for child in block["children"]:
                    self.identifier(child)
            payload = block.get(field, {})
            if kind in TEXT_FIELDS:
                self.web_text(payload)
            elif kind == 27:
                self.web_object(payload, ("token", "width", "height", "align", "caption", "scale"), ("token",))
                if payload["token"] != block["block_id"]:
                    self.fail("网页图片必须使用本次块标识占位。", "IMAGE_FORBIDDEN")
                for key in ("width", "height"):
                    if key in payload:
                        self.web_number(payload[key])
                if "align" in payload:
                    self.web_number(payload["align"], 1, 3)
                if "caption" in payload:
                    self.web_object(payload["caption"], ("content",), ("content",))
                    if not isinstance(payload["caption"]["content"], str):
                        self.fail("网页图片说明无效。", "INVALID_PARAMS")
                if "scale" in payload and (type(payload["scale"]) not in (int, float) or not 0 < payload["scale"] <= 1):
                    self.fail("网页图片缩放无效。", "INVALID_PARAMS")
            elif kind == 31:
                self.web_object(payload, ("property",), ("property",))
                prop = payload["property"]
                self.web_object(prop, ("row_size", "column_size", "column_width", "header_row", "header_column"),
                                ("row_size", "column_size"))
                for key in ("row_size", "column_size"):
                    self.web_number(prop[key], 1, 5000)
                if len(block.get("children", [])) != prop["row_size"] * prop["column_size"]:
                    self.fail("网页表格单元格数量与行列不一致。", "INVALID_PARAMS")
                if "column_width" in prop:
                    if not isinstance(prop["column_width"], list) or len(prop["column_width"]) != prop["column_size"]:
                        self.fail("网页表格列宽无效。", "INVALID_PARAMS")
                    for width in prop["column_width"]:
                        self.web_number(width)
                if any(type(prop[key]) is not bool for key in ("header_row", "header_column") if key in prop):
                    self.fail("网页表格标题样式无效。", "INVALID_PARAMS")
            elif kind == 19:
                self.web_object(payload, ("background_color", "border_color", "text_color", "emoji_id"))
                for key, maximum in (("background_color", 15), ("border_color", 7), ("text_color", 7)):
                    if key in payload:
                        self.web_number(payload[key], 1, maximum)
                # Browser adapters deliberately emit this small official set;
                # unknown source emoji remain text instead of inventing an icon.
                if "emoji_id" in payload and payload["emoji_id"] not in (
                        "bulb", "white_check_mark", "memo", "pushpin", "exclamation", "gift"):
                    self.fail("网页高亮块表情标识无效。", "INVALID_PARAMS")
                if not block.get("children"):
                    self.fail("网页高亮块缺少正文子块。", "INVALID_PARAMS")
            elif kind in (24, 25):
                # These container variants need platform-specific layout data;
                # browser extraction emits a quote container instead.
                self.fail("网页布局容器尚未支持，请重新读取正文。", "UNSUPPORTED_CONTENT")
            elif kind != 1:
                self.web_object(payload, ())
            if kind in (22, 27) and block.get("children"):
                self.fail("网页图片或分隔线不能包含子块。", "INVALID_PARAMS")
        by_id = {block["block_id"]: block for block in blocks}
        for block in blocks:
            if block["block_type"] == 31 and any(by_id.get(child, {}).get("block_type") != 32 for child in block["children"]):
                self.fail("网页表格的子块必须是单元格。", "INVALID_PARAMS")

    def prepare_web(self, params):
        operation = self.identifier(params.get("operation_id"), True)
        source_url = self.web_url(params.get("source_url"))
        journal = self.store.read("operations.json", {})
        if operation in journal:
            record = journal[operation]
            if (record.get("mode") != "content" or record.get("source") != WEB_ROOT
                    or record.get("source_url") != source_url):
                self.fail("操作标识已用于其他网页剪存，请继续原任务。", "OPERATION_CONFLICT")
            _, record, plan = self.read(operation)
            if plan.get("source_url") != source_url:
                self.fail("本机网页快照与任务记录不一致。", "STATE_ERROR")
            return self.summary(record, plan, operation)
        if "snapshot" not in params:
            self.fail("请先在浏览器中读取网页正文。", "IMPORT_NOT_PREPARED")
        if len(journal) >= 10000:
            self.fail("本机恢复记录已达到上限。", "STATE_FULL")
        plan = self.build_web_plan(source_url, params["snapshot"])
        record = {"mode": "content", "source": WEB_ROOT, "source_url": source_url, "name": plan["title"],
                  "stage": "content_prepared", "block_count": len(plan["blocks"]) + 1, "image_count": len(plan["images"])}
        journal[operation] = record
        self.save(operation, journal, plan)
        return self.summary(record, plan, operation)

    def build_web_plan(self, source_url, snapshot):
        """Validate a complete browser snapshot before touching an existing plan."""
        self.web_object(snapshot, ("title", "source_url", "blocks", "images"), ("title", "source_url", "blocks", "images"))
        try:
            snapshot_size = len(json.dumps(snapshot, ensure_ascii=False, allow_nan=False).encode("utf-8"))
        except (TypeError, ValueError, RecursionError, UnicodeError):
            self.fail("网页快照编码无效。", "INVALID_PARAMS")
        if snapshot_size > MAX_WEB_SNAPSHOT:
            self.fail("网页快照超过 700 KiB 限制。", "IMPORT_TOO_LARGE")
        title = snapshot["title"]
        if not isinstance(title, str) or not 1 <= len(title) <= 800 or any(ord(c) < 32 for c in title):
            self.fail("网页标题无效或超过飞书新建限制。", "INVALID_PARAMS")
        if snapshot["source_url"] != source_url:
            self.fail("网页快照地址与剪存地址不一致。", "SOURCE_CHANGED")
        self.web_blocks(snapshot["blocks"])
        clean, roots, batches, images = self.sanitize(snapshot["blocks"], WEB_ROOT)
        supplied = snapshot["images"]
        if not isinstance(supplied, list) or len(supplied) != len(images):
            self.fail("网页图片与正文块未完整绑定。", "IMAGE_FORBIDDEN")
        expected = {item["block_id"]: item for item in images}
        seen = set()
        for item in supplied:
            self.web_object(item, ("block_id", "url", "width", "height", "display_width"), ("block_id", "url"))
            block_id = self.identifier(item["block_id"])
            if block_id not in expected or block_id in seen:
                self.fail("网页图片不属于正文或出现重复绑定。", "IMAGE_FORBIDDEN")
            seen.add(block_id)
            expected[block_id]["url"] = self.web_url(item["url"], image=True)
            if "display_width" in item:
                value = item["display_width"]
                if type(value) not in (int, float) or not 0 < value <= 100000:
                    self.fail("网页图片显示宽度无效。", "INVALID_PARAMS")
                expected[block_id]["display_width"] = value
            for key in ("width", "height"):
                if key in item:
                    self.web_number(item[key])
                    if key in expected[block_id] and expected[block_id][key] != item[key]:
                        self.fail("网页图片尺寸与正文不一致。", "IMAGE_FORBIDDEN")
                    expected[block_id][key] = item[key]
        plan = {"source": WEB_ROOT, "source_url": source_url, "title": title, "revision": None,
                "create_marker": CREATE_MARKER_PREFIX + str(uuid.uuid4()),
                "blocks": clean, "roots": roots, "batches": batches, "images": images,
                "batch_index": 0, "bindings": {}, "verified_blocks": [], "verify_page": "", "bookmarks": {}}
        self.add_origin_link(plan, source_url)
        return plan

    def can_refresh_web(self, operation, record, plan):
        if (record.get("mode") != "content" or plan.get("source") != WEB_ROOT or not plan.get("source_url")
                or record.get("stage") != "content_prepared" or record.get("copied_token")
                or record.get("content_verified") or "create_requested_at" in plan
                or plan.get("batch_index") != 0 or plan.get("bindings")
                or plan.get("verified_blocks") or plan.get("blocks_verified")
                or record.get("creation_retry", {}).get("pending")):
            return False
        for image in plan.get("images", []):
            if (image.get("staged") or image.get("uploaded_token") or image.get("bound")
                    or self.image_path(operation, image["block_id"]).exists()):
                return False
        return True

    def refresh_web(self, params):
        operation = self.identifier(params.get("operation_id"), True)
        request_id = self.identifier(params.get("request_id"), True)
        source_url = self.web_url(params.get("source_url"))
        journal, record, plan = self.read(operation)
        if record.get("source_url") != source_url or plan.get("source_url") != source_url:
            self.fail("重新读取的网页与当前任务不一致，已保留原内容。", "OPERATION_CONFLICT")
        requests = record.get("snapshot_refresh_request_ids", [])
        if request_id in requests:
            return {**self.summary(record, plan, operation), "refresh_request_id": request_id, "already_applied": True}
        if not self.can_refresh_web(operation, record, plan):
            self.fail("任务已有保存进度，已保留原文快照并继续已有进度。", "SNAPSHOT_REFRESH_FORBIDDEN")
        new_plan = self.build_web_plan(source_url, params.get("snapshot"))
        if len(requests) >= 1000:
            self.fail("该任务的重新读取记录已达到上限。", "STATE_FULL")
        suffix = hashlib.sha256(request_id.encode("utf-8")).hexdigest()[:32]
        prefix = "snapshot-" + operation + "-" + suffix
        backup_name, next_name = prefix + "-before.json", prefix + "-next.json"
        # Both immutable snapshots exist before the journal makes the refresh
        # visible. A restarted reader finishes that local transaction first.
        self.store.write(backup_name, plan)
        self.store.write(next_name, new_plan)
        record["snapshot_refresh_request_ids"] = [*requests, request_id]
        record["snapshot_refresh_history"] = [*record.get("snapshot_refresh_history", []),
            {"request_id": request_id, "at": time.time(), "backup_name": backup_name,
             "old_block_count": len(plan["blocks"]) + 1, "old_image_count": len(plan["images"]),
             "new_block_count": len(new_plan["blocks"]) + 1, "new_image_count": len(new_plan["images"])}]
        record["snapshot_refresh"] = {"request_id": request_id, "next_name": next_name, "pending": True}
        self.store.write("operations.json", journal)
        new_plan = self.apply_snapshot_refresh(operation, journal, record)
        return {**self.summary(record, new_plan, operation), "refresh_request_id": request_id, "already_applied": False}

    def apply_snapshot_refresh(self, operation, journal, record):
        intent = record["snapshot_refresh"]
        plan = self.store.read(intent["next_name"], {})
        if (plan.get("source") != WEB_ROOT or plan.get("source_url") != record.get("source_url")
                or record.get("copied_token") or record.get("content_verified")):
            self.fail("重新读取记录与保存任务不一致，已保留原内容。", "STATE_ERROR")
        self.store.write(self.plan_name(operation), plan)
        record.update({"name": plan["title"], "stage": "content_prepared",
                       "block_count": len(plan["blocks"]) + 1, "image_count": len(plan["images"])})
        record.pop("last_error", None)
        intent["pending"] = False
        self.store.write("operations.json", journal)
        return plan

    def retry_creation(self, params):
        """Apply one explicit user request to start a fresh creation attempt.

        The prior attempt may have created an unclaimed document. Only this
        user-triggered action can replace its marker; automatic recovery cannot.
        Journal the intent first so a crash cannot consume it twice or let an
        import step reuse the old attempt while its plan is being reset.
        """
        operation = self.identifier(params.get("operation_id"), True)
        request_id = self.identifier(params.get("request_id"), True)
        journal, record, plan = self.read(operation)
        requests = record.get("create_retry_request_ids", [])
        if request_id in requests:
            self.apply_creation_retry(operation, journal, record, plan)
            return {**self.summary(record, plan, operation), "retry_request_id": request_id, "already_applied": True}
        if (record.get("copied_token") or record.get("content_verified")
                or record.get("stage") not in {"content_create_pending", "content_create_uncertain",
                                               "content_recovering", "content_create_failed"}):
            self.fail("当前任务不需要重新创建，将继续已有保存进度。", "CREATE_RETRY_FORBIDDEN")
        if len(requests) >= 1000:
            self.fail("该任务的重新创建记录已达到上限，请保留记录供检查。", "STATE_FULL")
        summary = {"stage": record["stage"], "replaced_at": time.time()}
        marker = plan.get("create_marker")
        if isinstance(marker, str) and re.fullmatch(CREATE_MARKER_PREFIX + r"[0-9a-f-]{36}", marker):
            summary["marker"] = marker
        for key in ("create_requested_at", "create_recovery_deadline"):
            if isinstance(plan.get(key), (int, float)):
                summary[key] = plan[key]
        error = record.get("last_error", {})
        if isinstance(error, dict):
            summary["error"] = {key: error[key] for key in ("code", "phase", "at", "uncertain") if key in error}
        if isinstance(plan.get("create_error_code"), str):
            summary["error_code"] = plan["create_error_code"]
        record["create_attempt_history"] = [*record.get("create_attempt_history", []), summary]
        record["create_retry_request_ids"] = [*requests, request_id]
        record["creation_retry"] = {"request_id": request_id, "marker": CREATE_MARKER_PREFIX + str(uuid.uuid4()),
                                    "pending": True}
        self.store.write("operations.json", journal)
        self.apply_creation_retry(operation, journal, record, plan)
        return {**self.summary(record, plan, operation), "retry_request_id": request_id, "already_applied": False}

    def apply_creation_retry(self, operation, journal, record, plan):
        intent = record.get("creation_retry", {})
        if not intent.get("pending"):
            return False
        if record.get("copied_token") or record.get("content_verified"):
            self.fail("重新创建记录与已有文档不一致，已保留任务。", "STATE_ERROR")
        for key in ("create_preflight", "create_next_check", "create_candidate", "create_candidate_checked",
                    "create_recovery_deadline", "create_requested_at", "create_recovery_checks", "create_error_code",
                    "title_written", "title_verified"):
            plan.pop(key, None)
        plan["create_marker"] = intent["marker"]
        self.store.write(self.plan_name(operation), plan)
        record["stage"] = "content_prepared"
        record.pop("last_error", None)
        intent["pending"] = False
        self.store.write("operations.json", journal)
        return True

    def summary(self, record, plan, operation=None):
        images = [{key: image[key] for key in ("block_id", "token", "width", "height", "pixel_width", "pixel_height", "display_width", "align", "staged", "url") if key in image}
                  for image in plan["images"]]
        return {"title": plan["title"], "source_token": plan["source"], "block_count": len(plan["blocks"]) + 1,
                "image_count": len(images), "batch_count": len(plan["batches"]), "images": images,
                "stage": record["stage"], "document": record.get("file"),
                **({"source_url": plan["source_url"]} if plan.get("source_url") else {}),
                **({"refresh_required": True} if operation and self.refresh_required(operation, record, plan) else {})}

    def refresh_required(self, operation, record, plan):
        source = urlsplit(plan.get("source_url", ""))
        if (source.hostname not in ("scys.com", "www.scys.com")
                or not re.fullmatch(r"/articleDetail/xq_topic/[0-9]+/?", source.path)
                or not self.can_refresh_web(operation, record, plan)):
            return False
        return any(re.fullmatch(r"/articleDetail/xq_topic/ou_[0-9a-f]{32}/?", urlsplit(image.get("url", "")).path)
                   for image in plan["images"])

    def image_path(self, operation, block_id):
        return self.store.file("image-" + self.identifier(operation, True) + "-" + self.identifier(block_id) + ".bin")

    @staticmethod
    def image_signature(data, mime):
        return ((mime == "image/png" and data.startswith(b"\x89PNG\r\n\x1a\n")) or
                (mime == "image/jpeg" and data.startswith(b"\xff\xd8\xff")) or
                (mime == "image/gif" and data[:6] in (b"GIF87a", b"GIF89a")) or
                (mime == "image/webp" and data[:4] == b"RIFF" and data[8:12] == b"WEBP") or
                (mime == "image/bmp" and data.startswith(b"BM")))

    @staticmethod
    def staged_pixel_size(path):
        """Read dimensions of a legacy staged image without decoding/re-encoding it."""
        with path.open("rb") as stream:
            header = stream.read(32)
            if header.startswith(b"\x89PNG\r\n\x1a\n") and header[12:16] == b"IHDR" and len(header) >= 24:
                return struct.unpack(">II", header[16:24])
            if header[:6] in (b"GIF87a", b"GIF89a") and len(header) >= 10:
                return struct.unpack("<HH", header[6:10])
            if header[:2] == b"BM" and len(header) >= 26:
                dib = int.from_bytes(header[14:18], "little")
                if dib == 12:
                    return struct.unpack("<HH", header[18:22])
                if dib >= 40:
                    width, height = struct.unpack("<ii", header[18:26])
                    return width, abs(height)
            if header[:4] == b"RIFF" and header[8:12] == b"WEBP":
                if header[12:16] == b"VP8X" and len(header) >= 30:
                    return (1 + int.from_bytes(header[24:27], "little"), 1 + int.from_bytes(header[27:30], "little"))
                if header[12:16] == b"VP8L" and len(header) >= 25 and header[20] == 0x2f:
                    bits = int.from_bytes(header[21:25], "little")
                    return (bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1
                if header[12:16] == b"VP8 " and header[23:26] == b"\x9d\x01\x2a" and len(header) >= 30:
                    width, height = struct.unpack("<HH", header[26:30])
                    return width & 0x3fff, height & 0x3fff
            if header[:2] == b"\xff\xd8":
                stream.seek(2)
                rotated = False
                dimensions = None
                while stream.tell() < MAX_IMAGE:
                    prefix = stream.read(1)
                    if prefix != b"\xff":
                        break
                    marker = stream.read(1)
                    while marker == b"\xff":
                        marker = stream.read(1)
                    if not marker or marker in (b"\xda", b"\xd9"):
                        break
                    size = stream.read(2)
                    if len(size) != 2:
                        break
                    size = int.from_bytes(size, "big") - 2
                    if size < 0:
                        break
                    data = stream.read(size)
                    if len(data) != size:
                        break
                    if marker == b"\xe1" and data.startswith(b"Exif\0\0"):
                        tiff = data[6:]
                        order = "little" if tiff[:2] == b"II" else "big" if tiff[:2] == b"MM" else None
                        if order and len(tiff) >= 8:
                            offset = int.from_bytes(tiff[4:8], order)
                            count = int.from_bytes(tiff[offset:offset + 2], order)
                            for index in range(min(count, 4096)):
                                entry = tiff[offset + 2 + 12 * index:offset + 14 + 12 * index]
                                if len(entry) != 12:
                                    break
                                if (int.from_bytes(entry[:2], order) == 274 and int.from_bytes(entry[2:4], order) == 3
                                        and int.from_bytes(entry[4:8], order) == 1):
                                    rotated = int.from_bytes(entry[8:10], order) in (5, 6, 7, 8)
                    if marker[0] in (0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf) and len(data) >= 5:
                        height, width = struct.unpack(">HH", data[1:5])
                        dimensions = (width, height)
                if dimensions:
                    return dimensions[::-1] if rotated else dimensions
        return None

    def set_web_image_layout(self, image):
        width = max(1, round(min(image["pixel_width"], 720, image.get("display_width", 720))))
        image.update({"width": width, "height": max(1, round(image["pixel_height"] * width / image["pixel_width"]))})
        image.pop("scale", None)

    def restore_legacy_image_dimensions(self, operation, journal, plan):
        if plan["source"] != WEB_ROOT:
            return
        changed = False
        for image in plan["images"]:
            # Never change a committed or uncertain legacy replacement request.
            if image.get("bound") or image.get("bind_client_token") or image.get("pixel_width"):
                continue
            path = self.image_path(operation, image["block_id"])
            with path.open("rb") as stream:
                if digest(stream) != image.get("sha256"):
                    self.fail("旧任务图片在暂存后发生变化，不能据此恢复尺寸。", "IMAGE_CONFLICT")
            dimensions = self.staged_pixel_size(path)
            if not dimensions or any(type(value) is not int or not 1 <= value <= 100000 for value in dimensions):
                self.fail("旧任务图片缺少可核实的像素尺寸，请保留任务并重新读取原图。", "IMAGE_DIMENSIONS_REQUIRED")
            image.update(zip(("pixel_width", "pixel_height"), dimensions))
            self.set_web_image_layout(image)
            changed = True
        if changed:
            self.save(operation, journal, plan)

    def stage_image(self, params):
        operation = self.identifier(params.get("operation_id"), True)
        block_id = self.identifier(params.get("block_id"))
        journal, record, plan = self.read(operation)
        image = next((item for item in plan["images"] if item["block_id"] == block_id), None)
        if image is None:
            self.fail("图片不属于本次读取的文档。", "IMAGE_FORBIDDEN")
        pixel_keys = ("pixel_width", "pixel_height")
        supplied_pixels = any(key in params for key in pixel_keys)
        # An already-running extension worker can still use the old protocol.
        # Both fields absent is compatible; one absent is malformed, never a
        # reason to silently discard the other field or an earlier measurement.
        if supplied_pixels:
            if any(type(params.get(key)) is not int or not 1 <= params[key] <= 100000 for key in pixel_keys):
                self.fail("图片像素宽高必须成对提供且为有效正整数。", "INVALID_PARAMS")
            if any(key in image and image[key] != params[key] for key in pixel_keys):
                self.fail("图片像素尺寸与此前分块不一致。", "IMAGE_CONFLICT")
        offset, total = params.get("offset"), params.get("total_size")
        mime, encoded = params.get("mime_type"), params.get("data_base64")
        if type(offset) is not int or type(total) is not int or not 0 <= offset < total <= MAX_IMAGE or mime not in MIMES:
            self.fail("图片大小、偏移或类型无效。", "INVALID_PARAMS")
        if not isinstance(encoded, str) or len(encoded) > (MAX_CHUNK + 2) // 3 * 4:
            self.fail("图片分块超过大小限制。", "INVALID_PARAMS")
        try:
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError):
            self.fail("图片分块编码无效。", "INVALID_PARAMS")
        if not data or len(data) > MAX_CHUNK or offset + len(data) > total:
            self.fail("图片分块边界无效。", "INVALID_PARAMS")
        if "total_size" in image and (image["total_size"] != total or image["mime_type"] != mime):
            self.fail("图片元数据与此前分块不一致。", "IMAGE_CONFLICT")
        path = self.image_path(operation, block_id)
        present = path.stat().st_size if path.exists() else 0
        if offset > present:
            self.fail("图片分块不连续，请从已保存位置继续。", "IMAGE_OFFSET")
        remaining = data
        if offset < present:
            overlap = min(len(data), present - offset)
            with path.open("rb") as stream:
                stream.seek(offset)
                if stream.read(overlap) != data[:overlap]:
                    self.fail("重复图片分块与已保存数据不一致。", "IMAGE_CONFLICT")
            # A resumed extension may use larger transport chunks. Verify the
            # existing prefix, then append only genuinely new bytes.
            remaining = data[overlap:]
        if remaining:
            if image.get("staged"):
                self.fail("图片已暂存完成，不能追加内容。", "IMAGE_CONFLICT")
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "ab") as stream:
                stream.write(remaining)
                stream.flush()
                os.fsync(stream.fileno())
            present += len(remaining)
        image.update({"total_size": total, "mime_type": mime})
        if supplied_pixels:
            image.update({key: params[key] for key in pixel_keys})
        if present == total:
            with path.open("rb") as stream:
                if not self.image_signature(stream.read(16), mime):
                    self.fail("下载结果不是所声明的图片，未创建文档。", "IMAGE_INVALID")
                stream.seek(0)
                actual_digest = digest(stream)
                if image.get("sha256") and image["sha256"] != actual_digest:
                    self.fail("完整暂存图片与此前校验记录不一致。", "IMAGE_CONFLICT")
                image["sha256"] = actual_digest
            if plan["source"] == WEB_ROOT and not image.get("bound") and not image.get("bind_client_token"):
                if not image.get("pixel_width") or not image.get("pixel_height"):
                    dimensions = self.staged_pixel_size(path)
                    if not dimensions or any(type(value) is not int or not 1 <= value <= 100000 for value in dimensions):
                        self.fail("图片缺少可核实的像素尺寸，请保留任务并重新读取原图。", "IMAGE_DIMENSIONS_REQUIRED")
                    if any(key in image and image[key] != value for key, value in zip(pixel_keys, dimensions)):
                        self.fail("图片文件像素与此前分块不一致。", "IMAGE_CONFLICT")
                    image.update(zip(pixel_keys, dimensions))
                self.set_web_image_layout(image)
            image["staged"] = True
        self.save(operation, journal, plan)
        return {"next_offset": offset + len(data), "complete": image.get("staged") is True}

    def result(self, record, plan):
        completed = int(bool(record.get("copied_token"))) + plan["batch_index"]
        completed += sum(int(bool(image.get("uploaded_token"))) + int(image.get("bound") is True) for image in plan["images"])
        completed += int(record.get("content_verified") is True)
        completed += plan.get("link_index", 0)
        total = 2 + len(plan["batches"]) + 2 * len(plan["images"]) + len(plan.get("link_batches", []))
        if plan.get("create_marker"):
            total += 3
            completed += int(bool(plan.get("create_preflight"))) + int(bool(plan.get("title_written"))) + int(bool(plan.get("title_verified")))
        return {"stage": "complete" if record.get("content_verified") else record["stage"],
                "complete": record.get("content_verified") is True, "document": record.get("file"),
                "progress": {"completed": completed, "total": total, "phase": record["stage"]},
                "counts": {"blocks": len(plan["blocks"]) + 1, "images": len(plan["images"])},
                **({"deferred_until": plan["create_next_check"] * 1000}
                   if record.get("stage") == "content_recovering" and plan.get("create_next_check", 0) > time.time() else {})}

    def creation_candidates(self, marker):
        """A random marker is positive evidence; an empty listing is not failure proof."""
        data = self.host.api("GET", "/open-apis/drive/v1/files", {"order_by": "CreatedTime", "direction": "DESC"})
        files = data.get("files")
        # The root listing returns all files and does not support pagination.
        # Never interpret a truncated/unexpected response as an absent marker.
        if not isinstance(files, list) or data.get("has_more") or any(not isinstance(file, dict) for file in files):
            self.fail("暂时未能完整核对保存结果，已保留当前任务。", "INVALID_RESPONSE")
        matches = [file for file in files if file.get("name") == marker]
        if len(matches) > 1 or matches and matches[0].get("type") != "docx":
            self.fail("发现不一致的保存记录，已保留任务供检查。", "CREATE_RECOVERY_CONFLICT", True)
        return matches

    def recover_creation(self, operation, journal, record, plan):
        marker = plan.get("create_marker")
        if not isinstance(marker, str) or not re.fullmatch(CREATE_MARKER_PREFIX + r"[0-9a-f-]{36}", marker):
            # Old unknown requests were sent without a correlation marker.
            self.fail("上次保存未能确认创建结果，已有内容已保留；其他文章可以继续保存。", "CREATE_UNCERTAIN", True)
        now = time.time()
        record["stage"] = "content_recovering"
        if plan.get("create_next_check", 0) > now:
            return self.result(record, plan)
        candidate = plan.get("create_candidate")
        if not candidate:
            matches = self.creation_candidates(marker)
            if not matches:
                if now >= plan.get("create_recovery_deadline", now + CREATE_RECOVERY_SECONDS):
                    self.fail("飞书暂未返回保存结果，已保留内容；稍后重试将继续核对，不会重复新建。", "CREATE_UNCERTAIN", True)
                attempts = plan.get("create_recovery_checks", 0)
                delay = (1, 2, 4, 8, 15, 30)[min(attempts, 5)]
                plan.update({"create_next_check": now + delay, "create_recovery_checks": attempts + 1})
            else:
                token = self.identifier(matches[0].get("token"))
                if token == plan["source"]:
                    self.fail("恢复结果不是独立文档。", "CREATE_RECOVERY_CONFLICT", True)
                plan.update({"create_candidate": token, "create_next_check": 0})
            self.save(operation, journal, plan)
            return self.result(record, plan)
        token = self.identifier(candidate)
        if not plan.get("create_candidate_checked"):
            doc = self.host.api("GET", "/open-apis/docx/v1/documents/" + token).get("document", {})
            if not isinstance(doc, dict):
                raise self.Error("飞书暂未返回有效文档信息，正在继续核对。", "INVALID_RESPONSE",
                                 transient=True, retryable=True)
            if doc.get("document_id") != token or doc.get("title") != marker:
                self.fail("保存记录的标题或标识发生变化，已保留任务供检查。", "CREATE_RECOVERY_CONFLICT", True)
            plan["create_candidate_checked"] = True
        else:
            data = self.host.api("GET", "/open-apis/docx/v1/documents/" + token + "/blocks", {"page_size": 500})
            blocks = data.get("items")
            if isinstance(blocks, list) and len(blocks) == 1 and not isinstance(blocks[0], dict):
                raise self.Error("飞书暂未返回有效文档内容，正在继续核对。", "INVALID_RESPONSE",
                                 transient=True, retryable=True)
            if (data.get("has_more") or not isinstance(blocks, list) or len(blocks) != 1
                    or blocks[0].get("block_id") != token or blocks[0].get("block_type") != 1
                    or blocks[0].get("children", [])):
                self.fail("恢复的文档已有其他内容，已停止写入并保留任务。", "CREATE_RECOVERY_CONFLICT", True)
            self.accept_created(record, plan, token)
        self.save(operation, journal, plan)
        return self.result(record, plan)

    def accept_created(self, record, plan, token):
        record.update({"copied_token": token, "file": {"token": token, "type": "docx", "name": plan["title"],
                      "url": "https://www.feishu.cn/docx/" + token}, "stage": "content_appending"})
        plan["create_next_check"] = 0

    def finish_title(self, operation, journal, record, plan, token):
        """Only rename our own confirmed document; setting the same title is replayable."""
        record["stage"] = "content_titling"
        self.save(operation, journal, plan)
        if not plan.get("title_written"):
            try:
                self.host.api("PATCH", "/open-apis/drive/v1/files/" + token,
                              {"type": "docx"}, {"new_title": plan["title"]})
            except self.Error as error:
                if error.transient:
                    error.retryable = True
                raise
            plan["title_written"] = True
        else:
            doc = self.host.api("GET", "/open-apis/docx/v1/documents/" + token).get("document", {})
            if not isinstance(doc, dict):
                raise self.Error("飞书暂未返回有效标题信息，正在继续核对。", "INVALID_RESPONSE",
                                 transient=True, retryable=True)
            if doc.get("document_id") != token or doc.get("title") != plan["title"]:
                self.fail("文档标题尚未核对一致，已保留保存结果。", "CONTENT_MISMATCH")
            plan["title_verified"] = True
            record.update({"content_verified": True, "stage": "content_ready"})
        self.save(operation, journal, plan)
        return self.result(record, plan)

    def step(self, params):
        operation = self.identifier(params.get("operation_id"), True)
        journal, record, plan = self.read(operation)
        if self.apply_creation_retry(operation, journal, record, plan):
            return self.result(record, plan)
        if record.get("content_verified"):
            return self.result(record, plan)
        if any(not image.get("staged") for image in plan["images"]):
            self.fail("请先完整下载并暂存全部图片，再创建文档。", "IMAGES_NOT_READY")
        self.restore_legacy_image_dimensions(operation, journal, plan)
        if not record.get("copied_token"):
            if record.get("stage") in ("content_create_pending", "content_create_uncertain", "content_recovering"):
                return self.recover_creation(operation, journal, record, plan)
            if not plan.get("create_marker"):
                plan["create_marker"] = CREATE_MARKER_PREFIX + str(uuid.uuid4())
                self.save(operation, journal, plan)
            if not plan.get("create_preflight"):
                if self.creation_candidates(plan["create_marker"]):
                    self.fail("新建前发现同一保存标记，已保留任务供检查。", "CREATE_RECOVERY_CONFLICT", True)
                plan["create_preflight"] = True
                self.save(operation, journal, plan)
                return self.result(record, plan)
            record["stage"] = "content_create_pending"
            plan.update({"create_recovery_deadline": time.time() + CREATE_RECOVERY_SECONDS,
                         "create_requested_at": time.time(), "create_recovery_checks": 0})
            self.save(operation, journal, plan)
            try:
                data = self.host.api("POST", "/open-apis/docx/v1/documents", body={"title": plan["create_marker"]})
                document = data.get("document")
                if not isinstance(document, dict):
                    self.fail("飞书未返回有效新文档，结果尚未确认。", "CREATE_UNCERTAIN", True)
                token = self.identifier(document.get("document_id"))
                if token == plan["source"]:
                    self.fail("新建结果不是独立文档。", "CREATE_UNCERTAIN", True)
            except self.Error as error:
                if error.code == "INVALID_PARAMS":
                    error = self.Error("飞书未返回有效新文档，结果尚未确认。", "CREATE_UNCERTAIN", True)
                record["stage"] = "content_create_uncertain" if error.uncertain else "content_create_failed"
                if error.uncertain:
                    record["stage"] = "content_recovering"
                    plan.update({"create_next_check": time.time() + 1, "create_error_code": error.code})
                self.save(operation, journal, plan)
                if error.uncertain:
                    return self.result(record, plan)
                raise error
            self.accept_created(record, plan, token)
            self.save(operation, journal, plan)
            return self.result(record, plan)
        token = self.identifier(record["copied_token"])
        if token == plan["source"]:
            self.fail("禁止修改源文档。", "IMPORT_FORBIDDEN")
        if plan["batch_index"] < len(plan["batches"]):
            batch = plan["batches"][plan["batch_index"]]
            if "bookmark" in batch:
                return self.append_bookmark(operation, journal, record, plan, batch, token)
            record["stage"] = "content_appending"
            self.save(operation, journal, plan)
            data = self.host.api("POST", "/open-apis/docx/v1/documents/" + token + "/blocks/" + token + "/descendant",
                                 {"client_token": batch["client_token"]},
                                 {"children_id": batch["children_id"], "descendants": batch["descendants"], "index": -1})
            relations = data.get("block_id_relations")
            if not isinstance(relations, list):
                self.fail("飞书未返回新建块映射，请继续同一任务恢复。", "INVALID_RESPONSE", True)
            try:
                mapping = {self.identifier(item.get("temporary_block_id")): self.identifier(item.get("block_id"))
                           for item in relations if isinstance(item, dict)}
            except self.Error:
                self.fail("飞书新建块映射格式无效，请继续同一任务恢复。", "INVALID_RESPONSE", True)
            expected = {block["block_id"] for block in batch["descendants"]}
            if (not expected.issubset(mapping) or len(set(mapping.values())) != len(mapping)
                    or set(mapping.values()) & ({token, plan["source"]} | set(plan["bindings"].values()))):
                self.fail("飞书新建块映射不完整，请继续同一任务恢复。", "INVALID_RESPONSE", True)
            plan["bindings"].update({key: mapping[key] for key in expected})
            plan["batch_index"] += 1
            self.save(operation, journal, plan)
            return self.result(record, plan)
        for image in plan["images"]:
            if image.get("bound") or image.get("uploaded_token"):
                continue
            block_id = self.identifier(plan["bindings"].get(image["block_id"]))
            record["stage"] = "content_images"
            if not image.get("uploaded_token"):
                image.setdefault("upload_attempts", int(bool(image.get("upload_pending"))))
                if image.get("upload_attempts", 0) >= 3:
                    self.fail("图片连续三次上传未能确认，请保留当前任务与新文档并检查网络。", "IMAGE_UPLOAD_UNCERTAIN", True)
                path = self.image_path(operation, image["block_id"])
                with path.open("rb") as stream:
                    if digest(stream) != image["sha256"]:
                        self.fail("本机图片在暂存后发生变化，请检查图片。", "IMAGE_CONFLICT")
                image["upload_pending"] = True
                image["upload_attempts"] = image.get("upload_attempts", 0) + 1
                self.save(operation, journal, plan)
                try:
                    body = {"file_name": "image" + MIMES[image["mime_type"]], "parent_type": "docx_image",
                            "parent_node": block_id, "size": str(image["total_size"]),
                            "extra": json.dumps({"drive_route_token": token})}
                    data = self.host.run(["api", "POST", "/open-apis/drive/v1/medias/upload_all", "--as", "user",
                                          "--format", "json", "--data", json.dumps(body), "--file", "file=" + path.name], write=True)
                    image["uploaded_token"] = self.identifier(data.get("file_token"))
                except self.Error as error:
                    if error.code == "MISSING_SCOPE":
                        error = self.Error("飞书缺少权限 docs:document.media:upload，请重新登录并授权。", "MISSING_SCOPE")
                    if error.code == "INVALID_PARAMS":
                        error = self.Error("图片上传结果尚未确认，请保留当前任务与新文档。", "IMAGE_UPLOAD_UNCERTAIN", True)
                    if not error.uncertain and error.code != "INVALID_PARAMS":
                        image["upload_pending"] = False
                        # Explicitly rejected requests do not consume the
                        # allowance for uncertain transport outcomes.
                        image["upload_attempts"] -= 1
                        self.save(operation, journal, plan)
                    elif image["upload_attempts"] < 3:
                        # Reuploading immutable image bytes can leave an
                        # unbound media asset, but cannot duplicate a document
                        # or a block. Only a confirmed token is ever bound.
                        self.save(operation, journal, plan)
                        return self.result(record, plan)
                    raise error
                image["upload_pending"] = False
                self.save(operation, journal, plan)
                return self.result(record, plan)
        if self.bind_images(operation, journal, record, plan, token):
            return self.result(record, plan)
        if "link_batches" not in plan:
            requests = []
            for source_id, block in plan["blocks"].items():
                elements = rewritten_elements(block, plan["source"], plan["bindings"], token,
                                              plan.get("origin_link", {}).get("block_id"))
                if elements is not None:
                    requests.append({"block_id": plan["bindings"][source_id],
                                     "update_text_elements": {"elements": elements}})
            plan["link_batches"] = [{"requests": requests[start:start + 200], "client_token": str(uuid.uuid4())}
                                    for start in range(0, len(requests), 200)]
            plan["link_index"] = 0
            if requests:
                # Any earlier verification snapshot predates these link edits.
                plan.update({"verified_blocks": [], "verify_page": "", "verify_seen": [],
                             "blocks_verified": False, "bookmark_final_index": 0})
            self.save(operation, journal, plan)
        if plan.get("link_index", 0) < len(plan["link_batches"]):
            batch = plan["link_batches"][plan["link_index"]]
            record["stage"] = "content_links"
            self.save(operation, journal, plan)
            self.host.api("PATCH", "/open-apis/docx/v1/documents/" + token + "/blocks/batch_update",
                          {"client_token": batch["client_token"]}, {"requests": batch["requests"]})
            plan["link_index"] += 1
            self.save(operation, journal, plan)
            return self.result(record, plan)
        if plan.get("blocks_verified"):
            bookmarks = list(plan.get("bookmarks", {}).items())
            index = plan.get("bookmark_final_index", 0)
            if index < len(bookmarks):
                source_id, expected = bookmarks[index]
                if self.read_bookmark(token, plan["bindings"][source_id]) != expected:
                    self.fail("最终核对发现链接卡片标题或网址已改变，暂不迁入知识库。", "CONTENT_MISMATCH")
                plan["bookmark_final_index"] = index + 1
            if plan.get("bookmark_final_index", 0) == len(bookmarks):
                if plan.get("create_marker") and not plan.get("title_verified"):
                    # The final bookmark read already consumed this step's remote request.
                    if index < len(bookmarks):
                        self.save(operation, journal, plan)
                        return self.result(record, plan)
                    return self.finish_title(operation, journal, record, plan, token)
                record.update({"content_verified": True, "stage": "content_ready"})
            self.save(operation, journal, plan)
            return self.result(record, plan)
        record["stage"] = "content_verifying"
        self.save(operation, journal, plan)
        query = {"page_size": 500}
        if plan["verify_page"]:
            query["page_token"] = plan["verify_page"]
        data = self.host.api("GET", "/open-apis/docx/v1/documents/" + token + "/blocks", query)
        items = data.get("items")
        if not isinstance(items, list):
            self.fail("新文档内容核对返回无效，请继续查询。", "INVALID_RESPONSE")
        plan["verified_blocks"].extend(items)
        if data.get("has_more"):
            page = data.get("page_token")
            if (not isinstance(page, str) or not page or len(page) > 2048
                    or page in plan.get("verify_seen", []) or page == plan["verify_page"]
                    or len(plan["verified_blocks"]) > len(plan["blocks"]) + 1):
                self.fail("新文档核对分页异常。", "INVALID_RESPONSE")
            plan.setdefault("verify_seen", []).append(page)
            plan["verify_page"] = page
            self.save(operation, journal, plan)
            return self.result(record, plan)
        self.verify(plan, token)
        if plan.get("bookmarks") or plan.get("create_marker") and not plan.get("title_verified"):
            plan.update({"blocks_verified": True, "bookmark_final_index": 0})
        else:
            record.update({"content_verified": True, "stage": "content_ready"})
        self.save(operation, journal, plan)
        return self.result(record, plan)

    def bind_images(self, operation, journal, record, plan, token):
        """Bind at most 20 media resources with one durable, replayable request."""
        def request_for(image):
            return {"block_id": self.identifier(plan["bindings"].get(image["block_id"])),
                    "replace_image": {"token": image["uploaded_token"], **{
                        key: image[key] for key in ("width", "height", "align", "caption", "scale") if key in image}}}

        # A previous helper may have committed a singleton PATCH but lost its
        # response. Reuse its original UUID/body before forming any new batch.
        legacy = next((image for image in plan["images"] if image.get("bind_client_token") and not image.get("bound")), None)
        if legacy:
            record["stage"] = "content_images"
            self.save(operation, journal, plan)
            self.host.api("PATCH", "/open-apis/docx/v1/documents/" + token + "/blocks/batch_update",
                          {"client_token": legacy["bind_client_token"]}, {"requests": [request_for(legacy)]})
            legacy["bound"] = True
            self.save(operation, journal, plan)
            return True
        if "image_bind_batches" not in plan:
            waiting = [image for image in plan["images"] if not image.get("bound")]
            plan["image_bind_batches"] = [{"client_token": str(uuid.uuid4()),
                                           "image_ids": [image["block_id"] for image in waiting[start:start + 20]],
                                           "requests": [request_for(image) for image in waiting[start:start + 20]]}
                                          for start in range(0, len(waiting), 20)]
            self.save(operation, journal, plan)
        batch = next((batch for batch in plan["image_bind_batches"] if not batch.get("complete")), None)
        if batch is None:
            return False
        record["stage"] = "content_images"
        self.save(operation, journal, plan)
        self.host.api("PATCH", "/open-apis/docx/v1/documents/" + token + "/blocks/batch_update",
                      {"client_token": batch["client_token"]}, {"requests": batch["requests"]})
        bound_ids = set(batch["image_ids"])
        for image in plan["images"]:
            if image["block_id"] in bound_ids:
                image["bound"] = True
        batch["complete"] = True
        self.save(operation, journal, plan)
        return True

    def append_bookmark(self, operation, journal, record, plan, batch, token):
        """Append a native bookmark, then locate and read it back before advancing.

        The v2 write has no client_token. Persist intent first and recover by
        reading the exact appended position; never repeat an uncertain append.
        """
        record["stage"] = "content_bookmarks"
        source_id = batch["children_id"][0]
        if not batch.get("bookmark_pending"):
            batch["bookmark_pending"] = True
            self.save(operation, journal, plan)
            markup = ET.tostring(ET.Element("bookmark", batch["bookmark"]), encoding="unicode")
            try:
                result = self.host.run(["docs", "+update", "--api-version", "v2", "--as", "user", "--doc", token,
                                        "--command", "append", "--doc-format", "xml", "--content", markup], write=True)
                if result.get("result") != "success" or result.get("warnings"):
                    self.fail("链接卡片写入结果需核对，请继续当前任务。", "BOOKMARK_UNCERTAIN", True)
            except self.Error as error:
                if not error.uncertain:
                    batch["bookmark_pending"] = False
                    self.save(operation, journal, plan)
                raise
            return self.result(record, plan)
        if not batch.get("destination_id"):
            root = self.host.api("GET", "/open-apis/docx/v1/documents/" + token + "/blocks/" + token).get("block", {})
            children = root.get("children", [])
            preceding = [source for part in plan["batches"][:plan["batch_index"]] for source in part["children_id"]]
            expected = [plan["bindings"][source] for source in preceding]
            if not isinstance(children, list) or len(children) != len(expected) + 1 or children[:-1] != expected:
                self.fail("链接卡片写入位置尚未确认，已保留文档；不会重复插入卡片。", "BOOKMARK_UNCERTAIN", True)
            destination = self.identifier(children[-1])
            if destination in set(plan["bindings"].values()) | {token, plan["source"]}:
                self.fail("链接卡片返回的标识无效。", "BOOKMARK_UNCERTAIN", True)
            batch["destination_id"] = destination
            self.save(operation, journal, plan)
            return self.result(record, plan)
        if self.read_bookmark(token, batch["destination_id"]) != batch["bookmark"]:
            self.fail("链接卡片的标题或网址与原文不一致，暂不迁入知识库。", "CONTENT_MISMATCH")
        plan["bindings"][source_id] = batch["destination_id"]
        batch["bookmark_verified"] = True
        plan["batch_index"] += 1
        self.save(operation, journal, plan)
        return self.result(record, plan)

    def verify(self, plan, token):
        target = {block.get("block_id"): block for block in plan["verified_blocks"] if isinstance(block, dict)}
        mapping = plan["bindings"]
        if len(target) != len(plan["blocks"]) + 1 or token not in target:
            self.fail("新文档块数量与原文不一致，暂不迁入知识库。", "CONTENT_MISMATCH")
        if target[token].get("children", []) != [mapping[root] for root in plan["roots"]]:
            self.fail("新文档段落顺序与原文不一致，暂不迁入。", "CONTENT_MISMATCH")

        def contains(expected, actual):
            if isinstance(expected, dict):
                return isinstance(actual, dict) and all(contains(value, actual.get(key)) for key, value in expected.items())
            if isinstance(expected, list):
                return isinstance(actual, list) and len(expected) == len(actual) and all(contains(e, a) for e, a in zip(expected, actual))
            return expected == actual

        for source_id, original in plan["blocks"].items():
            if original["block_type"] == 999 and not any(part.get("bookmark_verified") and part["children_id"] == [source_id] for part in plan["batches"]):
                self.fail("链接卡片尚未核对，暂不迁入知识库。", "CONTENT_MISMATCH")
            wanted = copy.deepcopy(original)
            elements = rewritten_elements(original, plan["source"], mapping, token,
                                          plan.get("origin_link", {}).get("block_id"))
            if elements is not None:
                wanted[TEXT_FIELDS[original["block_type"]]]["elements"] = elements
            wanted["block_id"] = mapping[source_id]
            if "children" in wanted:
                wanted["children"] = [mapping[child] for child in wanted["children"]]
            if wanted["block_type"] == 27:
                image = next(item for item in plan["images"] if item["block_id"] == source_id)
                wanted["image"]["token"] = image["uploaded_token"]
                for key in ("width", "height", "scale"):
                    if key in image:
                        wanted["image"][key] = image[key]
            actual = copy.deepcopy(target.get(mapping[source_id]))
            try:
                apply_block_defaults(wanted)
                apply_block_defaults(actual)
            except (AttributeError, TypeError, ValueError):
                self.fail("新文档内容块格式无效，暂不迁入知识库。", "CONTENT_MISMATCH")
            field = TEXT_FIELDS.get(wanted["block_type"])
            if field:
                try:
                    wanted_text = wanted[field].pop("elements", [])
                    actual_text = actual[field].pop("elements", [])
                    if semantic_text_elements(wanted_text) != semantic_text_elements(actual_text):
                        self.fail("新文档文字、空白或行内样式与原文不一致，暂不迁入知识库。", "CONTENT_MISMATCH")
                except (KeyError, TypeError, AttributeError, ValueError):
                    self.fail("新文档富文本结构尚未与原文核对一致，暂不迁入知识库。", "CONTENT_MISMATCH")
            if not contains(wanted, actual):
                self.fail("新文档内容或格式尚未与原文核对一致，暂不迁入知识库。", "CONTENT_MISMATCH")
