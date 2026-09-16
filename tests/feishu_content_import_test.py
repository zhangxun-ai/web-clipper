"""Public-block import protocol tests; all CLI and Feishu effects are simulated."""

import base64
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("native_content_test", ROOT / "helper/feishu_native_host.py")
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


def text(block_id, content, **extra):
    return {"block_id": block_id, "block_type": 2, "parent_id": "Source",
            "text": {"elements": [{"text_run": {"content": content, "text_element_style":
                {"bold": True, "link": {"url": "https://example.com"}, "comment_ids": ["PrivateComment"]}}}],
                "style": {"align": 1, "background_color": "LightGrayBackground"}}, **extra}


def assert_origin_paragraph(test_case, plan, expected_url, target=None):
    """Validate the additional source paragraph, never discard it from checks."""
    origin = plan["origin_link"]
    test_case.assertEqual(origin["url"], expected_url)
    block_id = origin["block_id"]
    test_case.assertEqual(plan["roots"][0], block_id)
    block = plan["blocks"][block_id]
    test_case.assertEqual(block["block_type"], 2)
    runs = [element["text_run"] for element in block["text"]["elements"]]
    test_case.assertTrue("".join(run["content"] for run in runs).startswith("原文出处："))
    test_case.assertEqual([(run["content"], run.get("text_element_style", {}).get("link", {}).get("url"))
                          for run in runs if run.get("text_element_style", {}).get("link")],
                         [("查看原文", expected_url)])
    if target is None:
        return block_id
    destination = plan["bindings"][block_id]
    test_case.assertEqual(target["Created"]["children"][0], destination)
    test_case.assertEqual(target[destination]["text"], block["text"])
    return destination


class ImportCLI:
    def __init__(self):
        self.source = [
            {"block_id": "Source", "block_type": 1, "children": ["Text", "Table", "Image"]},
            text("CellText", "单元格"), text("Text", "完整原文\n第二行"),
            {"block_id": "Image", "block_type": 27, "image":
                {"token": "OriginalImage", "width": 100, "height": 50, "align": 2, "scale": 0.5}},
            {"block_id": "Table", "block_type": 31, "children": ["Cell"], "table":
                {"cells": ["Cell"], "property": {"row_size": 1, "column_size": 1, "column_width": [100],
                 "header_row": True, "merge_info": [{"row_span": 1, "col_span": 1}]}}},
            {"block_id": "Cell", "block_type": 32, "children": ["CellText"], "table_cell": {}}]
        self.target, self.calls, self.cache = {}, [], {}
        self.failure, self.revision = None, 1
        self.bookmarks = {}
        self.created_title = ""

    def __call__(self, argv, **kwargs):
        self.calls.append(argv)
        self.assert_user(argv)
        if argv[1] == "docs":
            self.assert_v2(argv)
            doc = argv[argv.index("--doc") + 1]
            if argv[2] == "+fetch":
                block_id = argv[argv.index("--start-block-id") + 1]
                attrs = self.bookmarks.get(block_id, {})
                node = ET.Element("bookmark" if attrs else "undefined", {"id": block_id, **attrs})
                fragment = ET.Element("fragment"); fragment.append(node)
                data = {"document": {"content": ET.tostring(fragment, encoding="unicode")}}
            else:
                assert doc == "Created" and argv[argv.index("--command") + 1] == "append"
                node = ET.fromstring(argv[argv.index("--content") + 1])
                assert node.tag == "bookmark" and set(node.attrib) == {"name", "href"}
                block_id = "NewBookmark" + str(len(self.bookmarks))
                self.bookmarks[block_id] = dict(node.attrib)
                self.target[block_id] = {"block_id": block_id, "block_type": 999, "undefined": {}}
                self.target["Created"]["children"].append(block_id)
                if self.failure and self.failure[0] == "bookmark_after":
                    self.failure = None
                    raise subprocess.TimeoutExpired(argv, 30)
                data = {"result": "success", "warnings": []}
            return subprocess.CompletedProcess(argv, 0, json.dumps({"ok": True, "data": data}), "")
        method, path = argv[2:4]
        body = json.loads(argv[argv.index("--data") + 1]) if "--data" in argv else {}
        query = json.loads(argv[argv.index("--params") + 1]) if "--params" in argv else {}
        if self.failure and self.failure[0] == "before":
            _, failure = self.failure
            self.failure = None
            if isinstance(failure, Exception):
                raise failure
            return subprocess.CompletedProcess(argv, 1, "", json.dumps(failure))
        if method == "GET" and path.endswith("/Source"):
            data = {"document": {"document_id": "Source", "title": "原标题", "revision_id": self.revision}}
        elif method == "GET" and path.endswith("/Source/blocks"):
            data = {"items": self.source, "has_more": False}
        elif method == "POST" and path == "/open-apis/docx/v1/documents":
            self.target = {"Created": {"block_id": "Created", "block_type": 1, "children": []}}
            self.created_title = body["title"]
            data = {"document": {"document_id": "Created", "title": body["title"]}}
        elif method == "GET" and path == "/open-apis/drive/v1/files":
            data = {"files": [{"name": self.created_title, "token": "Created", "type": "docx"}] if self.created_title else [], "has_more": False}
        elif method == "PATCH" and path == "/open-apis/drive/v1/files/Created":
            assert query == {"type": "docx"} and set(body) == {"new_title"}
            self.created_title = body["new_title"]
            data = {}
        elif method == "GET" and path == "/open-apis/docx/v1/documents/Created":
            data = {"document": {"document_id": "Created", "title": self.created_title}}
        elif path.endswith("/descendant"):
            key = query["client_token"]
            if key not in self.cache:
                mapping = {block["block_id"]: "New" + block["block_id"] for block in body["descendants"]}
                for original in body["descendants"]:
                    block = copy.deepcopy(original)
                    block["block_id"] = mapping[block["block_id"]]
                    if "children" in block:
                        block["children"] = [mapping[child] for child in block["children"]]
                    self.target[block["block_id"]] = block
                self.target["Created"]["children"].extend(mapping[key] for key in body["children_id"])
                self.cache[key] = {"block_id_relations": [{"temporary_block_id": key, "block_id": value}
                                                         for key, value in mapping.items()]}
            data = self.cache[key]
        elif path.endswith("/medias/upload_all"):
            assert body["parent_node"] == "NewImage"
            assert json.loads(body["extra"])["drive_route_token"] == "Created"
            upload_name = Path(argv[argv.index("--file") + 1].split("=", 1)[1])
            assert not upload_name.is_absolute() and len(upload_name.parts) == 1
            assert (Path(kwargs["cwd"]) / upload_name).is_file()
            data = {"file_token": "UploadedImage"}
        elif path.endswith("/blocks/batch_update"):
            for request in body["requests"]:
                block = self.target[request["block_id"]]
                if "replace_image" in request:
                    block["image"].update(request["replace_image"])
                elif "update_text_elements" in request:
                    block["text"]["elements"] = copy.deepcopy(request["update_text_elements"]["elements"])
            data = {}
        elif method == "GET" and path.endswith("/Created/blocks"):
            data = {"items": list(self.target.values()), "has_more": False}
        elif method == "GET" and path.endswith("/Created/blocks/Created"):
            data = {"block": self.target["Created"]}
        else:
            raise AssertionError("Unexpected API route")
        if self.failure and self.failure[0] == "after":
            _, failure = self.failure
            self.failure = None
            raise failure
        return subprocess.CompletedProcess(argv, 0, json.dumps({"ok": True, "identity": "user", "data": data}), "")

    @staticmethod
    def assert_user(argv):
        assert argv[argv.index("--as") + 1] == "user"
        assert "--yes" not in argv

    @staticmethod
    def assert_v2(argv):
        assert argv[argv.index("--api-version") + 1] == "v2"


class ContentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="feishu-content-test-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name).resolve() / "state"
        self.cli = ImportCLI()
        self.host = native.NativeHost("/mock/lark-cli", self.directory, self.cli)
        self.operation = "import-operation"
        self.png = b"\x89PNG\r\n\x1a\n" + b"x" * 600000

    def call(self, action, **params):
        return self.host.handle({"action": action, "params": {"operation_id": self.operation, **params}})

    def prepare(self):
        result = self.call("prepare_content", token="Source")
        self.assertTrue(result["ok"], result)
        return result["data"]

    def add_bookmark(self, index=1):
        self.cli.source[0]["children"].insert(index, "Bookmark")
        self.cli.source.append({"block_id": "Bookmark", "block_type": 999, "undefined": {}})
        self.cli.bookmarks["Bookmark"] = {"name": '标题 < & "原样"', "href": "https://example.com/article?a=1&b=2"}

    def advance_until(self, predicate):
        for _ in range(30):
            _, _, plan = self.host.content.read(self.operation)
            if predicate(plan):
                return plan
            result = self.step()
            self.assertTrue(result["ok"], result)
        self.fail("Import did not reach the expected persisted phase")

    @staticmethod
    def bookmark_batch(plan):
        return next((index, batch) for index, batch in enumerate(plan["batches"])
                    if batch.get("children_id") == ["Bookmark"] and "bookmark" in batch)

    def assert_saved_roots(self, body_roots=("NewText", "NewTable", "NewImage")):
        _, _, plan = self.host.content.read(self.operation)
        origin = assert_origin_paragraph(self, plan, "https://www.feishu.cn/docx/Source", self.cli.target)
        self.assertEqual(self.cli.target["Created"]["children"], [origin, *body_roots])
        return plan

    def test_native_bookmark_recreated_in_original_position_and_read_back(self):
        for index in (0, 1, 3):
            with self.subTest(index=index):
                self.setUp()
                self.add_bookmark(index)
                self.prepare(); self.stage()
                for _ in range(20):
                    result = self.step()
                    self.assertTrue(result["ok"], result)
                    if result["data"]["complete"]:
                        break
                self.assertTrue(result["data"]["complete"])
                _, _, plan = self.host.content.read(self.operation)
                card_id = plan["bindings"]["Bookmark"]
                self.assert_saved_roots([plan["bindings"][source_id] for source_id in self.cli.source[0]["children"]])
                self.assertEqual(self.cli.target["Created"]["children"][index + 1], card_id)
                self.assertEqual(self.cli.bookmarks[card_id], self.cli.bookmarks["Bookmark"])
                self.assertTrue(any(c[1:3] == ["docs", "+fetch"] and card_id in c for c in self.cli.calls))

    def test_bookmark_timeout_after_commit_recovers_without_duplicate_append(self):
        self.add_bookmark(0); self.prepare(); self.stage()
        self.advance_until(lambda plan: plan["batch_index"] == self.bookmark_batch(plan)[0])
        self.cli.failure = ("bookmark_after", True)
        failed = self.call("import_step")
        self.assertTrue(failed["uncertain"])
        for _ in range(20):
            result = self.step()
            self.assertTrue(result["ok"], result)
            if result["data"]["complete"]:
                break
        self.assertTrue(result["data"]["complete"])
        self.assertEqual(sum(c[1:3] == ["docs", "+update"] for c in self.cli.calls), 1)

    def test_other_unknown_resources_not_silently_skipped_or_converted_to_links(self):
        self.add_bookmark(); self.cli.bookmarks.clear()
        result = self.call("prepare_content", token="Source")
        self.assertEqual(result["code"], "UNSUPPORTED_CONTENT")
        self.assertFalse(any(c[2] in ("POST", "+update") for c in self.cli.calls))

    def test_bookmark_mismatch_prevents_advancing_to_following_content(self):
        self.add_bookmark(0); self.prepare(); self.stage()
        self.advance_until(lambda plan: bool(self.bookmark_batch(plan)[1].get("destination_id")))
        for block_id in self.cli.bookmarks:
            if block_id != "Bookmark": self.cli.bookmarks[block_id]["href"] = "https://wrong.example/"
        result = self.call("import_step")
        self.assertEqual(result["code"], "CONTENT_MISMATCH")
        _, record, plan = self.host.content.read(self.operation)
        bookmark_index, batch = self.bookmark_batch(plan)
        self.assertEqual(plan["batch_index"], bookmark_index)
        origin = assert_origin_paragraph(self, plan, "https://www.feishu.cn/docx/Source", self.cli.target)
        self.assertEqual(self.cli.target["Created"]["children"], [origin, batch["destination_id"]])
        self.assertFalse(record.get("content_verified"))

    def test_final_verification_rereads_bookmark_after_earlier_successful_check(self):
        self.add_bookmark(0); self.prepare(); self.stage()
        plan = self.advance_until(lambda plan: self.bookmark_batch(plan)[1].get("bookmark_verified"))
        self.assertTrue(self.bookmark_batch(plan)[1]["bookmark_verified"])
        self.cli.bookmarks[plan["bindings"]["Bookmark"]]["href"] = "https://changed.example/"
        for _ in range(20):
            result = self.step()
            if not result["ok"]: break
        self.assertEqual(result.get("code"), "CONTENT_MISMATCH")
        _, record, _ = self.host.content.read(self.operation)
        self.assertFalse(record.get("content_verified"))

    def test_empty_quote_retains_container_and_adds_only_a_blank_paragraph(self):
        self.cli.source[0]["children"].insert(0, "EmptyQuote")
        self.cli.source.append({"block_id": "EmptyQuote", "block_type": 34, "quote_container": {}})
        self.prepare(); self.stage()
        for _ in range(10):
            result = self.step()
            self.assertTrue(result["ok"], result)
            if result["data"]["complete"]: break
        self.assertTrue(result["data"]["complete"])
        quote = self.cli.target["NewEmptyQuote"]
        self.assertEqual(quote["block_type"], 34)
        self.assertEqual(len(quote["children"]), 1)
        child = self.cli.target[quote["children"][0]]
        self.assertEqual(child["text"]["elements"], [{"text_run": {"content": ""}}])

    def chunk(self, offset, size=196608, content=None):
        data = self.png if content is None else content
        return self.call("stage_image", block_id="Image", offset=offset, total_size=len(data),
                         mime_type="image/png", data_base64=base64.b64encode(data[offset:offset + size]).decode())

    def stage(self):
        for offset in range(0, len(self.png), 196608):
            result = self.chunk(offset)
            self.assertTrue(result["ok"], result)
        self.assertTrue(result["data"]["complete"])
        # Complete the new read-only creation preflight before tests exercise
        # their specific write/verification step. No document exists yet.
        self.assertTrue(self.step()["ok"])
        self.assertFalse(self.cli.created_title)

    def step(self):
        count = len(self.cli.calls)
        result = self.call("import_step")
        self.assertLessEqual(len(self.cli.calls) - count, 1)
        return result

    def through_upload(self):
        self.prepare()
        self.stage()
        for _ in range(3):
            self.assertTrue(self.step()["ok"])

    def finish(self):
        for _ in range(20):
            result = self.step()
            self.assertTrue(result["ok"], result)
            if result["data"]["complete"]:
                return result
        self.fail("Import did not finish content and title verification")

    def test_readable_source_rebuilds_all_content_without_copy_permission(self):
        summary = self.prepare()
        self.assertEqual(summary["block_count"], 7)  # Source paragraph + the six original blocks including root.
        self.assertFalse(summary["images"][0]["staged"])
        self.assertIsNone(summary["document"])
        self.assertEqual(self.step()["code"], "IMAGES_NOT_READY")
        self.stage()
        for _ in range(7):
            result = self.step()
            self.assertTrue(result["ok"], result)
        self.assertTrue(result["data"]["complete"])
        self.assertEqual(result["data"]["counts"], {"blocks": 7, "images": 1})
        self.assertEqual(result["data"]["progress"]["completed"], result["data"]["progress"]["total"])
        self.assertEqual(self.cli.target["NewImage"]["image"]["scale"], 0.5)
        self.assertNotIn("OriginalImage", json.dumps(self.cli.target))
        self.assertNotIn("PrivateComment", json.dumps(self.cli.target))
        self.assertNotIn("cells", self.cli.target["NewTable"]["table"])
        self.assertNotIn("merge_info", self.cli.target["NewTable"]["table"]["property"])
        self.assert_saved_roots()
        self.assertFalse(any("/copy" in call[3] or "/auth" in call[3] for call in self.cli.calls))
        self.assertFalse(any(call[2] != "GET" and "/Source" in call[3] for call in self.cli.calls))
        count = len(self.cli.calls)
        self.host = native.NativeHost("/mock/lark-cli", self.directory, self.cli)
        self.assertTrue(self.step()["data"]["complete"])
        resumed = self.prepare()
        self.assertTrue(resumed["images"][0]["staged"])
        self.assertEqual(resumed["document"]["token"], "Created")
        self.assertEqual(len(self.cli.calls), count)

    def test_restart_replays_identical_image_chunks_with_request_end_offset(self):
        self.prepare()
        self.chunk(0)
        self.chunk(196608)
        self.host = native.NativeHost("/mock/lark-cli", self.directory, self.cli)
        result = self.chunk(0)
        self.assertEqual(result["data"], {"next_offset": 196608, "complete": False})
        conflicting = b"z" * len(self.png)
        self.assertEqual(self.chunk(0, content=conflicting)["code"], "IMAGE_CONFLICT")
        self.stage()
        self.assertTrue(self.chunk(0)["data"]["complete"])

    def test_unknown_create_outcome_is_never_reissued_after_restart(self):
        self.prepare()
        self.stage()
        self.cli.failure = ("after", subprocess.TimeoutExpired([], 30))
        result = self.step()
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["progress"]["phase"], "content_recovering")
        count = len(self.cli.calls)
        self.host = native.NativeHost("/mock/lark-cli", self.directory, self.cli)
        self.assertEqual(self.step()["data"]["progress"]["phase"], "content_recovering")
        self.assertEqual(len(self.cli.calls), count)

    def test_known_scope_failure_can_retry_after_authorization(self):
        self.prepare()
        self.stage()
        self.cli.failure = ("before", {"ok": False, "error": {"code": 99991672, "message": "secret"}})
        failure = self.step()
        self.assertEqual(failure["code"], "MISSING_SCOPE")
        self.assertIn("docx:document:create", failure["error"])
        self.assertNotIn("secret", json.dumps(failure))
        self.assertTrue(self.step()["ok"])

    def test_descendant_retries_same_uuid_without_duplicate_blocks(self):
        self.prepare()
        self.stage()
        self.step()
        self.cli.failure = ("after", subprocess.TimeoutExpired([], 30))
        failure = self.step()
        self.assertTrue(failure["uncertain"])
        self.assertTrue(failure["retryable"])
        first = self.cli.calls[-1]
        self.assertTrue(self.step()["ok"])
        second = self.cli.calls[-1]
        self.assertEqual(first, second)
        query = json.loads(first[first.index("--params") + 1])
        self.assertEqual(uuid.UUID(query["client_token"]).version, 4)
        self.assertEqual(len(self.cli.target), 7)
        self.assert_saved_roots()

    def test_missing_default_table_and_text_flags_do_not_stop_complete_import(self):
        table = next(b for b in self.cli.source if b["block_id"] == "Table")
        table["table"]["property"].update(header_row=False, header_column=False)
        source_text = next(b for b in self.cli.source if b["block_id"] == "Text")
        source_text["text"]["style"].update(done=False, folded=False, wrap=False)
        self.prepare(); self.stage(); self.step(); self.step()
        for key in ("header_row", "header_column"):
            self.cli.target["NewTable"]["table"]["property"].pop(key)
        for key in ("align", "done", "folded", "wrap"):
            self.cli.target["NewText"]["text"]["style"].pop(key)
        for _ in range(5):
            result = self.step()
            self.assertTrue(result["ok"], result)
            if result["data"]["complete"]: break
        self.assertTrue(result["data"]["complete"])

    def test_real_table_setting_changes_still_fail_and_are_not_auto_retryable(self):
        for expected, actual in ((True, None), (False, True), (True, False), (False, 0)):
            with self.subTest(expected=expected, actual=actual):
                self.setUp()
                table = next(b for b in self.cli.source if b["block_id"] == "Table")
                table["table"]["property"]["header_row"] = expected
                self.prepare(); self.stage(); self.step(); self.step()
                prop = self.cli.target["NewTable"]["table"]["property"]
                if actual is None: prop.pop("header_row")
                else: prop["header_row"] = actual
                for _ in range(5):
                    result = self.step()
                    if not result["ok"]: break
                self.assertEqual(result.get("code"), "CONTENT_MISMATCH")
                self.assertFalse(result.get("retryable", False))

    def test_retryable_server_failure_keeps_same_batch_and_safe_diagnostics(self):
        self.prepare(); self.stage(); self.step()
        for _ in range(22):
            self.cli.failure = ("before", {"code": 1771001, "message": "PRIVATE SERVER DETAIL"})
            result = self.step()
            self.assertTrue(result["retryable"])
        journal, record, plan = self.host.content.read(self.operation)
        self.assertEqual(plan["batch_index"], 0)
        self.assertEqual(len(record["error_history"]), 20)
        self.assertEqual(record["last_error"]["phase"], "content_appending")
        self.assertEqual(record["last_error"]["code"], "1771001")
        self.assertNotIn("PRIVATE", json.dumps(record))
        self.host = native.NativeHost("/mock/lark-cli", self.directory, self.cli)
        self.assertTrue(self.step()["ok"])
        self.assertEqual(len(self.cli.target), 7)
        self.assert_saved_roots()

    def test_unknown_creation_cannot_be_automatically_replayed(self):
        self.prepare(); self.stage()
        self.cli.failure = ("after", subprocess.TimeoutExpired([], 30))
        first = self.step()
        self.assertTrue(first["ok"])
        self.assertFalse(first["data"]["complete"])
        self.assertIn("deferred_until", first["data"])
        self.assertFalse(first.get("retryable", False))
        count = len(self.cli.calls)
        second = self.step()
        self.assertEqual(second["data"]["progress"]["phase"], "content_recovering")
        self.assertFalse(second.get("retryable", False))
        self.assertEqual(len(self.cli.calls), count)

    def test_image_binding_timeout_automatically_replays_same_patch_uuid(self):
        self.through_upload()
        self.cli.failure = ("after", subprocess.TimeoutExpired([], 30))
        result = self.step()
        self.assertTrue(result["retryable"])
        self.assertTrue(result["uncertain"])
        first = self.cli.calls[-1]
        self.assertTrue(self.step()["ok"])
        self.assertEqual(self.cli.calls[-1], first)

    def test_verification_timeout_preserves_phase_and_retries_only_a_read(self):
        self.through_upload(); self.step()
        self.cli.failure = ("before", subprocess.TimeoutExpired([], 30))
        result = self.step()
        self.assertTrue(result["retryable"])
        self.assertFalse(result.get("uncertain", False))
        _, record, _ = self.host.content.read(self.operation)
        self.assertEqual(record["last_error"]["phase"], "content_verifying")
        result = self.step()
        self.assertTrue(result["ok"])
        self.assertEqual(self.cli.calls[-1][2], "GET")
        self.assertTrue(self.finish()["data"]["complete"])

    def test_unverified_new_document_cannot_move(self):
        self.through_upload()
        count = len(self.cli.calls)
        result = self.call("move_doc", obj_token="Created", space_id="123", parent_node_token="Parent")
        self.assertEqual(result["code"], "CONTENT_NOT_VERIFIED")
        self.assertEqual(len(self.cli.calls), count)
        self.assertTrue(self.step()["ok"])
        self.cli.target["NewText"]["text"]["elements"][0]["text_run"]["content"] = "changed"
        self.assertEqual(self.step()["code"], "CONTENT_MISMATCH")
        self.assertEqual(self.call("move_doc", obj_token="Created", space_id="123")["code"], "CONTENT_NOT_VERIFIED")

    def test_image_upload_unknown_outcome_retries_only_media_and_binds_confirmed_token(self):
        self.prepare()
        self.stage()
        self.step()
        self.step()
        self.cli.failure = ("after", subprocess.TimeoutExpired([], 30))
        self.assertTrue(self.step()["ok"])
        _, _, plan = self.host.content.read(self.operation)
        self.assertTrue(plan["images"][0]["upload_pending"])
        self.assertNotIn("uploaded_token", plan["images"][0])
        self.assertTrue(self.step()["ok"])
        self.assertTrue(self.step()["ok"])
        self.assertTrue(self.finish()["data"]["complete"])
        self.assertEqual(self.cli.target["NewImage"]["image"]["token"], "UploadedImage")
        self.assertEqual(sum(c[3] == "/open-apis/docx/v1/documents" for c in self.cli.calls), 1)
        self.assertEqual(sum(c[3].endswith("/descendant") for c in self.cli.calls), 1)

    def test_uncertain_image_upload_retries_are_bounded_across_restarts(self):
        self.prepare(); self.stage(); self.step(); self.step()
        for attempt in range(3):
            self.cli.failure = ("after", subprocess.TimeoutExpired([], 30))
            result = self.step()
            if attempt < 2: self.assertTrue(result["ok"])
            else: self.assertTrue(result["uncertain"])
            self.host = native.NativeHost("/mock/lark-cli", self.directory, self.cli)
        count = len(self.cli.calls)
        self.assertEqual(self.step()["code"], "IMAGE_UPLOAD_UNCERTAIN")
        self.assertEqual(len(self.cli.calls), count)

    def test_legacy_pending_upload_counts_prior_attempt_and_resumes(self):
        self.prepare(); self.stage(); self.step(); self.step()
        journal, _, plan = self.host.content.read(self.operation)
        plan["images"][0]["upload_pending"] = True
        plan["images"][0].pop("upload_attempts", None)
        self.host.content.save(self.operation, journal, plan)
        self.assertTrue(self.step()["ok"])
        _, _, plan = self.host.content.read(self.operation)
        self.assertEqual(plan["images"][0]["upload_attempts"], 2)
        self.host = native.NativeHost("/mock/lark-cli", self.directory, self.cli)
        self.assertTrue(self.step()["ok"])
        self.assertEqual(sum(c[3].endswith("/medias/upload_all") for c in self.cli.calls), 1)

    def test_pending_upload_cannot_retry_changed_local_bytes(self):
        self.prepare(); self.stage(); self.step(); self.step()
        self.cli.failure = ("after", subprocess.TimeoutExpired([], 30))
        self.assertTrue(self.step()["ok"])
        self.host.content.image_path(self.operation, "Image").write_bytes(b"changed")
        count = len(self.cli.calls)
        self.assertEqual(self.step()["code"], "IMAGE_CONFLICT")
        self.assertEqual(len(self.cli.calls), count)

    def test_cli_local_file_validation_is_known_failure_and_retryable(self):
        self.prepare()
        self.stage()
        self.step()
        self.step()
        self.cli.failure = ("before", {"ok": False, "error": {"type": "validation",
            "message": "cannot open file: PRIVATE_PATH", "details": {"cause": "private"}}})
        result = self.step()
        self.assertEqual(result["code"], "CLI_VALIDATION")
        self.assertNotIn("uncertain", result)
        self.assertNotIn("PRIVATE_PATH", json.dumps(result))
        plan = self.host.store.read("content-" + self.operation + ".json", {})
        self.assertFalse(plan["images"][0]["upload_pending"])
        original = self.cli.__call__
        def runner(argv, **kwargs):
            self.assertEqual(kwargs["cwd"], str(self.directory))
            return original(argv, **kwargs)
        self.host.runner = runner
        self.assertTrue(self.step()["ok"])

    def test_unsupported_content_and_real_merges_rejected_before_create(self):
        for change in (lambda: self.cli.source[3].update(block_type=99),
                       lambda: self.cli.source[4]["table"]["property"].update(merge_info=[{"row_span": 2}])):
            self.cli = ImportCLI()
            self.host = native.NativeHost("/mock/lark-cli", self.directory, self.cli)
            change()
            result = self.call("prepare_content", token="Source")
            self.assertEqual(result["code"], "UNSUPPORTED_CONTENT")
            self.assertTrue(all(call[2] == "GET" for call in self.cli.calls))

    def test_image_parameter_checks_prevent_local_path_and_wrong_content(self):
        self.prepare()
        for args in ({"block_id": "../bad"}, {"offset": True}, {"mime_type": "text/html"}, {"data_base64": "%%%%"},
                     {"total_size": 21 * 1024 * 1024}, {"offset": 4}):
            params = {"block_id": "Image", "offset": 0, "total_size": 100,
                      "mime_type": "image/png", "data_base64": base64.b64encode(b"hello").decode(), **args}
            self.assertFalse(self.call("stage_image", **params)["ok"])
        self.assertEqual(self.chunk(0, content=b"<html>login</html>")["code"], "IMAGE_INVALID")
        self.assertEqual(self.step()["code"], "IMAGES_NOT_READY")

    def test_batches_obey_image_limit_and_preserve_root_order(self):
        images = [{"block_id": "I" + str(i), "block_type": 27, "image": {"token": "T" + str(i)}} for i in range(28)]
        self.cli.source = [{"block_id": "Source", "block_type": 1, "children": [b["block_id"] for b in images]}, *images]
        self.assertEqual(self.prepare()["batch_count"], 2)
        plan = self.host.store.read("content-" + self.operation + ".json", {})
        origin = assert_origin_paragraph(self, plan, "https://www.feishu.cn/docx/Source")
        self.assertEqual([len(batch["descendants"]) for batch in plan["batches"]], [21, 8])
        self.assertEqual([sum(block["block_type"] == 27 for block in batch["descendants"])
                          for batch in plan["batches"]], [20, 8])
        self.assertEqual([root for batch in plan["batches"] for root in batch["children_id"]],
                         [origin, *[b["block_id"] for b in images]])

    def test_source_revision_change_stops_before_document_creation(self):
        original = self.cli.__call__
        def runner(argv, **kwargs):
            result = original(argv, **kwargs)
            if argv[3].endswith("/Source/blocks"):
                self.cli.revision += 1
            return result
        self.host.runner = runner
        self.assertEqual(self.call("prepare_content", token="Source")["code"], "SOURCE_CHANGED")
        self.assertFalse(self.host.store.read("operations.json", {}))
        self.assertTrue(all(call[2] == "GET" for call in self.cli.calls))

    def test_verification_pages_resume_after_host_restart(self):
        self.through_upload()
        self.step()
        original = self.cli.__call__
        def runner(argv, **kwargs):
            result = original(argv, **kwargs)
            if argv[3].endswith("/Created/blocks"):
                data = json.loads(result.stdout)
                items = data["data"]["items"]
                query = json.loads(argv[argv.index("--params") + 1])
                first = "page_token" not in query
                data["data"] = {"items": items[:3] if first else items[3:], "has_more": first, "page_token": "second"}
                result.stdout = json.dumps(data)
            return result
        self.host.runner = runner
        first = self.step()
        self.assertTrue(first["ok"], first)
        self.assertFalse(first["data"]["complete"])
        self.host = native.NativeHost("/mock/lark-cli", self.directory, runner)
        second = self.step()
        self.assertTrue(second["ok"], second)
        self.assertTrue(self.host.content.read(self.operation)[2]["blocks_verified"])
        self.assertTrue(self.finish()["data"]["complete"])

    def test_invalid_block_mapping_is_uncertain_and_never_advances_batch(self):
        self.prepare()
        self.stage()
        self.step()
        original = self.cli.__call__
        def runner(argv, **kwargs):
            result = original(argv, **kwargs)
            if argv[3].endswith("/descendant"):
                data = json.loads(result.stdout)
                data["data"]["block_id_relations"][0]["block_id"] = "Source"
                result.stdout = json.dumps(data)
            return result
        self.host.runner = runner
        result = self.step()
        self.assertTrue(result["uncertain"])
        self.assertEqual(result["code"], "INVALID_RESPONSE")
        plan = self.host.store.read("content-" + self.operation + ".json", {})
        self.assertEqual(plan["batch_index"], 0)

    def test_internal_links_rewrite_only_known_source_anchors(self):
        block = next(item for item in self.cli.source if item["block_id"] == "Text")
        urls = ["https://feishu.cn/docx/Source#CellText", "#Image",
                "https://example.com/docx/Source#CellText", "https://feishu.cn/docx/Other#CellText",
                "https://feishu.cn/docx/Source#Unknown", "#Unknown",
                "https://feishu.cn.evil.example/docx/Source#CellText",
                "https://user:password@feishu.cn/docx/Source#CellText"]
        block["text"]["elements"] = [{"text_run": {"content": "原文" + str(i), "text_element_style":
            {"bold": True, "italic": False, "link": {"url": url}}}} for i, url in enumerate(urls)]
        self.prepare()
        self.stage()
        for _ in range(8):
            result = self.step()
            self.assertTrue(result["ok"], result)
        self.assertTrue(result["data"]["complete"])
        target = self.cli.target["NewText"]["text"]
        mapped = [e["text_run"]["text_element_style"]["link"]["url"] for e in target["elements"]]
        self.assertEqual(mapped, ["https://www.feishu.cn/docx/Created#NewCellText", "https://www.feishu.cn/docx/Created#NewImage", *urls[2:]])
        self.assertEqual([e["text_run"]["content"] for e in target["elements"]], ["原文" + str(i) for i in range(len(urls))])
        self.assertTrue(all(e["text_run"]["text_element_style"]["bold"] for e in target["elements"]))
        self.assertEqual(target["style"], block["text"]["style"])
        count = len(self.cli.calls)
        self.assertTrue(self.step()["data"]["complete"])
        self.assertEqual(count, len(self.cli.calls))

    def test_link_timeout_resumes_same_uuid_and_replacement_body(self):
        block = next(item for item in self.cli.source if item["block_id"] == "Text")
        block["text"]["elements"][0]["text_run"]["text_element_style"]["link"]["url"] = "#CellText"
        self.through_upload()
        self.assertTrue(self.step()["ok"])
        self.cli.failure = ("after", subprocess.TimeoutExpired([], 30))
        self.assertTrue(self.step()["uncertain"])
        first = self.cli.calls[-1]
        self.host = native.NativeHost("/mock/lark-cli", self.directory, self.cli)
        self.assertTrue(self.step()["ok"])
        self.assertEqual(self.cli.calls[-1], first)
        self.assertTrue(self.finish()["data"]["complete"])
        self.assertEqual(len(self.cli.target), 7)
        self.assert_saved_roots()

    def test_old_verified_document_can_repair_links_without_recreating_blocks(self):
        self.through_upload()
        self.step()
        self.assertTrue(self.finish()["data"]["complete"])
        plan_name = "content-" + self.operation + ".json"
        plan = self.host.store.read(plan_name, {})
        plan["blocks"]["Text"]["text"]["elements"][0]["text_run"]["text_element_style"]["link"]["url"] = "#CellText"
        plan.pop("link_batches")
        plan.pop("link_index")
        self.host.store.write(plan_name, plan)
        journal = self.host.store.read("operations.json", {})
        journal[self.operation]["content_verified"] = False
        self.host.store.write("operations.json", journal)
        count = len(self.cli.calls)
        self.assertTrue(self.step()["ok"])
        self.assertTrue(self.step()["data"]["complete"])
        later = self.cli.calls[count:]
        self.assertEqual([call[2] for call in later], ["PATCH", "GET"])
        self.assertTrue(all("/Created/" in call[3] for call in later))


if __name__ == "__main__":
    unittest.main()
