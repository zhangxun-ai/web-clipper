"""Browser article snapshots reuse the guarded document importer without source API reads."""

import base64
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("web_import_fixtures", Path(__file__).with_name("feishu_content_import_test.py"))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)


def paragraph(block_id, content):
    return {"block_id": block_id, "block_type": 2, "text": {"elements": [{"text_run": {
        "content": content, "text_element_style": {"bold": True, "link": {"url": "https://example.com/reference"}}
    }}], "style": {"align": 1}}}


def snapshot():
    return {"title": "网页正文与图片", "source_url": "https://scys.com/articleDetail/xq_topic/55521155258121884",
            "blocks": [{"block_id": "WebRoot", "block_type": 1, "children": ["Text", "Table", "Image"]},
                       paragraph("Text", "完整正文\n第二行"), paragraph("CellText", "表格内容"),
                       {"block_id": "Table", "block_type": 31, "children": ["Cell"],
                        "table": {"property": {"row_size": 1, "column_size": 1, "header_row": True}}},
                       {"block_id": "Cell", "block_type": 32, "children": ["CellText"], "table_cell": {}},
                       {"block_id": "Image", "block_type": 27, "image": {"token": "Image", "width": 100, "height": 50}}],
            "images": [{"block_id": "Image", "url": "https://images.example.com/article.png", "width": 100, "height": 50}]}


class WebImportTests(unittest.TestCase):
    def setUp(self):
        # Each directory is disposable test state created by this test.
        self.temp = tempfile.TemporaryDirectory(prefix="feishu-web-import-test-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name).resolve() / "state"
        self.cli = fixtures.ImportCLI()
        self.host = fixtures.native.NativeHost("/mock/lark-cli", self.directory, self.cli)
        self.operation = "web-operation-123"
        self.source = snapshot()

    def call(self, action, **params):
        return self.host.handle({"action": action, "params": {"operation_id": self.operation, **params}})

    def prepare(self, value=None):
        return self.call("prepare_web_content", source_url=self.source["source_url"],
                         snapshot=value if value is not None else self.source)

    def stage(self):
        data = b"\x89PNG\r\n\x1a\n" + b"test image bytes"
        return self.call("stage_image", block_id="Image", offset=0, total_size=len(data), mime_type="image/png",
                         data_base64=base64.b64encode(data).decode())

    def finish(self):
        for _ in range(20):
            result = self.call("import_step")
            self.assertTrue(result["ok"], result)
            if result["data"]["complete"]:
                return result["data"]
        self.fail("Article import did not complete")

    def test_full_article_text_table_and_independent_image_are_verified(self):
        result = self.prepare()
        self.assertTrue(result["ok"], result)
        self.assertEqual(self.cli.calls, [])
        self.assertEqual(result["data"]["source_token"], "WebRoot")
        self.assertEqual(result["data"]["source_url"], self.source["source_url"])
        self.assertEqual(result["data"]["images"][0]["url"], self.source["images"][0]["url"])
        self.assertIs(result["data"]["images"][0]["staged"], False)
        self.assertEqual(self.call("import_step")["code"], "IMAGES_NOT_READY")
        self.assertEqual(self.cli.calls, [])
        self.assertTrue(self.stage()["ok"])
        result = self.finish()
        self.assertEqual(result["counts"], {"blocks": 6, "images": 1})
        self.assertEqual(self.cli.target["NewText"]["text"], self.source["blocks"][1]["text"])
        self.assertEqual(self.cli.target["NewImage"]["image"]["token"], "UploadedImage")
        self.assertEqual(self.cli.target["Created"]["children"], ["NewText", "NewTable", "NewImage"])
        self.assertTrue(all(argv[3].startswith("/open-apis/") for argv in self.cli.calls))
        self.assertTrue(all(argv[2] != "GET" or "/Created" in argv[3]
                            or argv[3] == "/open-apis/drive/v1/files" for argv in self.cli.calls))
        self.assertNotIn(self.source["images"][0]["url"], json.dumps(self.cli.calls))
        journal = self.host.store.read("operations.json", {})
        self.assertIs(journal[self.operation]["content_verified"], True)
        self.assertEqual(journal[self.operation]["source_url"], self.source["source_url"])

    def test_reopen_without_snapshot_does_not_fetch_or_create_and_retains_staging(self):
        first = self.prepare()
        self.assertTrue(first["ok"])
        self.assertTrue(self.stage()["ok"])
        self.host = fixtures.native.NativeHost("/mock/lark-cli", self.directory, self.cli)
        result = self.call("prepare_web_content", source_url=self.source["source_url"])
        self.assertTrue(result["ok"])
        self.assertIs(result["data"]["images"][0]["staged"], True)
        self.assertEqual(self.cli.calls, [])
        self.finish()
        count = len(self.cli.calls)
        changed = copy.deepcopy(self.source)
        changed["title"] = "不得覆盖已准备内容"
        self.assertTrue(self.prepare(changed)["ok"])
        self.assertEqual(self.call("import_step")["data"]["document"]["name"], self.source["title"])
        self.assertEqual(len(self.cli.calls), count)
        creates = [argv for argv in self.cli.calls if argv[2:4] == ["POST", "/open-apis/docx/v1/documents"]]
        self.assertEqual(len(creates), 1)

    def test_uncertain_creation_never_repeats_after_resume(self):
        self.assertTrue(self.prepare()["ok"])
        self.assertTrue(self.stage()["ok"])
        self.assertTrue(self.call("import_step")["ok"])  # Read-only creation preflight.
        self.cli.failure = ("after", subprocess.TimeoutExpired([], 30))
        result = self.call("import_step")
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["progress"]["phase"], "content_recovering")
        count = len(self.cli.calls)
        self.host = fixtures.native.NativeHost("/mock/lark-cli", self.directory, self.cli)
        self.assertTrue(self.call("prepare_web_content", source_url=self.source["source_url"])["ok"])
        self.assertEqual(self.call("import_step")["data"]["progress"]["phase"], "content_recovering")
        self.assertEqual(len(self.cli.calls), count)

    def test_operation_cannot_be_rebound_to_other_web_or_feishu_source(self):
        self.assertTrue(self.prepare()["ok"])
        self.assertEqual(self.call("prepare_web_content", source_url="https://example.com/other")["code"], "OPERATION_CONFLICT")
        self.assertEqual(self.call("prepare_content", token="WebRoot")["code"], "OPERATION_CONFLICT")
        self.assertEqual(self.cli.calls, [])

    def test_unprepared_resume_and_mismatched_snapshot_are_rejected(self):
        self.assertEqual(self.call("prepare_web_content", source_url=self.source["source_url"])["code"], "IMPORT_NOT_PREPARED")
        self.source["source_url"] = "https://example.com/changed"
        self.assertEqual(self.prepare(snapshot())["code"], "SOURCE_CHANGED")
        self.assertEqual(self.cli.calls, [])

    def test_snapshot_cannot_supply_import_state_commands_paths_or_unbound_images(self):
        mutations = [lambda s, key=key: s.update({key: "forged"}) for key in
                     ("uploaded_token", "staged", "bindings", "batches", "bookmarks", "parent_node_token", "command", "path")]
        mutations += [lambda s: s["blocks"][1].update({"parent_id": "../../outside"}),
                      lambda s: s["blocks"][1]["text"].update({"path": "/tmp/outside"}),
                      lambda s: s["blocks"][1]["text"]["elements"][0]["text_run"].update({"command": "shell"}),
                      lambda s: s["blocks"][-1]["image"].update({"uploaded_token": "AlreadyUploaded"}),
                      lambda s: s["images"][0].update({"staged": True}),
                      lambda s: s["images"][0].update({"block_id": "NotBound"}),
                      lambda s: s["images"][0].update({"block_id": "../path"}),
                      lambda s: s["blocks"][-1]["image"].update({"token": "ArbitraryDriveToken"}),
                      lambda s: s.update({"images": []})]
        for mutate in mutations:
            value = snapshot()
            mutate(value)
            result = self.prepare(value)
            self.assertFalse(result["ok"], result)
            self.assertNotEqual(result["code"], "HOST_ERROR")
        self.assertEqual(self.cli.calls, [])
        self.assertEqual(self.host.store.read("operations.json", {}), {})

    def test_source_image_and_inline_urls_reject_credentials_or_non_web_schemes(self):
        for value in ("https://user:secret@example.com/a", "https://@example.com/a", "file:///tmp/a", "javascript:alert(1)",
                      "https://example.com/\nprivate", "https://example.com:99999/a", "https://example.com\\evil/a"):
            self.assertEqual(self.call("prepare_web_content", source_url=value, snapshot=self.source)["code"], "INVALID_PARAMS")
            bad = snapshot()
            bad["images"][0]["url"] = value
            self.assertEqual(self.prepare(bad)["code"], "INVALID_PARAMS")
            bad = snapshot()
            bad["blocks"][1]["text"]["elements"][0]["text_run"]["text_element_style"]["link"]["url"] = value
            self.assertEqual(self.prepare(bad)["code"], "INVALID_PARAMS")
        self.assertEqual(self.cli.calls, [])

    def test_data_images_require_matching_binary_signature(self):
        bad = snapshot()
        bad["images"][0]["url"] = "data:image/png;base64," + base64.b64encode(b"<html>login</html>").decode()
        self.assertEqual(self.prepare(bad)["code"], "INVALID_PARAMS")
        good = snapshot()
        good["images"][0]["url"] = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\nimage").decode()
        self.assertTrue(self.prepare(good)["ok"])
        self.assertEqual(self.cli.calls, [])

    def test_missing_duplicate_cyclic_and_detached_blocks_are_rejected(self):
        mutations = [lambda s: s["blocks"][0]["children"].append("Missing"),
                     lambda s: s["blocks"].append(copy.deepcopy(s["blocks"][1])),
                     lambda s: s["blocks"][1].update({"children": ["Text"]}),
                     lambda s: s["blocks"].append(paragraph("Detached", "not in root")),
                     lambda s: s["blocks"][0].update({"block_id": "OtherRoot"}),
                     lambda s: s["blocks"][3]["children"].append("Text")]
        for mutate in mutations:
            bad = snapshot()
            mutate(bad)
            result = self.prepare(bad)
            self.assertFalse(result["ok"], result)
            self.assertNotEqual(result["code"], "HOST_ERROR")
        self.assertEqual(self.cli.calls, [])

    def test_size_and_type_limits_fail_before_state_or_creation(self):
        bad = snapshot()
        bad["blocks"][1]["text"]["elements"][0]["text_run"]["content"] = "x" * (700 * 1024)
        self.assertEqual(self.prepare(bad)["code"], "IMPORT_TOO_LARGE")
        bad = snapshot()
        bad["blocks"] = [bad["blocks"][0]] * 5001
        self.assertEqual(self.prepare(bad)["code"], "IMPORT_TOO_LARGE")
        for field, value in (("block_type", True), ("children", "Text"), ("block_id", "../../file")):
            bad = snapshot()
            bad["blocks"][0][field] = value
            self.assertEqual(self.prepare(bad)["code"], "INVALID_PARAMS")
        bad = snapshot()
        bad["blocks"][-1]["image"]["width"] = float("nan")
        self.assertEqual(self.prepare(bad)["code"], "INVALID_PARAMS")
        self.assertEqual(self.cli.calls, [])
        self.assertEqual(self.host.store.read("operations.json", {}), {})

    def test_stage_rejects_image_not_bound_to_snapshot(self):
        self.assertTrue(self.prepare()["ok"])
        result = self.call("stage_image", block_id="OtherImage", offset=0, total_size=8,
                           mime_type="image/png", data_base64=base64.b64encode(b"\x89PNG\r\n\x1a\n").decode())
        self.assertEqual(result["code"], "IMAGE_FORBIDDEN")
        self.assertEqual(self.cli.calls, [])

    def test_move_still_requires_verified_new_doc_from_same_journal(self):
        self.assertTrue(self.prepare()["ok"])
        self.assertTrue(self.stage()["ok"])
        self.assertTrue(self.call("import_step")["ok"])
        self.assertTrue(self.call("import_step")["ok"])
        result = self.call("move_doc", obj_token="Created", space_id="123")
        self.assertEqual(result["code"], "CONTENT_NOT_VERIFIED")
        result = self.call("move_doc", obj_token="OtherDoc", space_id="123")
        self.assertEqual(result["code"], "MOVE_FORBIDDEN")

    def verify_text(self, expected, actual):
        original = {"block_id": "Code", "block_type": 14, "code": {"elements": expected, "style": {"language": 1}}}
        copied = {"block_id": "NewCode", "block_type": 14, "code": {"elements": actual, "style": {"language": 1}}}
        plan = {"source": "WebRoot", "bindings": {"Code": "NewCode"}, "roots": ["Code"],
                "blocks": {"Code": original}, "verified_blocks": [
                    {"block_id": "Created", "block_type": 1, "children": ["NewCode"]}, copied]}
        return self.host.content.verify(plan, "Created")

    @staticmethod
    def text_run(content, style=None):
        return {"text_run": {"content": content, **({"text_element_style": style} if style is not None else {})}}

    def test_verification_accepts_platform_run_splitting_and_explicit_false_defaults(self):
        defaults = {key: False for key in ("bold", "italic", "underline", "strikethrough", "inline_code")}
        expected = [self.text_run("line 1\n\n  line 2\nlast line")]
        actual = [self.text_run("line 1\n\n  line 2\n", defaults), self.text_run("last line", defaults)]
        self.assertIsNone(self.verify_text(expected, actual))
        self.assertIsNone(self.verify_text(actual, expected))
        style = {"bold": True, "link": {"url": "https://example.com/reference"}}
        self.assertIsNone(self.verify_text([self.text_run("first ", style), self.text_run("second", style)],
                                          [self.text_run("first second", style)]))

    def test_verification_rejects_text_whitespace_or_partial_style_changes_after_splitting(self):
        expected = [self.text_run("line 1\n\n  last line")]
        variants = [[self.text_run("line 1\n\n  "), self.text_run("last LINE")],
                    [self.text_run("line 1\n "), self.text_run("last line")],
                    [self.text_run("line 1\n\n  "), self.text_run("last line", {"bold": True})],
                    [self.text_run("line 1\n\n  "), self.text_run("last line", {"inline_code": True})],
                    [self.text_run("line 1\n\n  "), self.text_run("last line", {"link": {"url": "https://example.com"}})]]
        for actual in variants:
            with self.subTest(actual=actual), self.assertRaises(fixtures.native.HostError) as error:
                self.verify_text(expected, actual)
            self.assertEqual(error.exception.code, "CONTENT_MISMATCH")
        original = [self.text_run("first second", {"bold": True, "link": {"url": "https://example.com/original"}})]
        changed = [self.text_run("first ", {"bold": True, "link": {"url": "https://example.com/original"}}),
                   self.text_run("second", {"bold": True, "link": {"url": "https://example.com/changed"}})]
        with self.assertRaises(fixtures.native.HostError) as error:
            self.verify_text(original, changed)
        self.assertEqual(error.exception.code, "CONTENT_MISMATCH")

    def test_mailto_is_only_allowed_for_body_links(self):
        value = snapshot()
        value["blocks"][1]["text"]["elements"][0]["text_run"]["text_element_style"]["link"]["url"] = "mailto:author@example.com"
        self.assertTrue(self.prepare(value)["ok"])
        self.assertEqual(self.call("prepare_web_content", source_url="mailto:author@example.com", snapshot=value)["code"], "INVALID_PARAMS")
        self.operation = "web-other-operation"
        value["images"][0]["url"] = "mailto:author@example.com"
        self.assertEqual(self.prepare(value)["code"], "INVALID_PARAMS")


if __name__ == "__main__":
    unittest.main()
