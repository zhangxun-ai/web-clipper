"""Origin attribution is additive, durable and verified; all Feishu effects are mocked."""
import copy
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid

spec = importlib.util.spec_from_file_location("source_link_fixtures", Path(__file__).with_name("feishu_content_import_test.py"))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)

WEB_URL = "https://scys.com/articleDetail/xq_topic/source-link?from=course&part=2#original-section"


def snapshot(count=1):
    ids = ["Paragraph" + str(index) for index in range(count)]
    return {"title": "保留原文与出处", "source_url": WEB_URL, "images": [], "blocks": [
        {"block_id": "WebRoot", "block_type": 1, "children": ids}, *[
            {"block_id": block_id, "block_type": 2, "text": {"elements": [
                {"text_run": {"content": "原文 " + str(index) + "\n第二行"}}]}}
            for index, block_id in enumerate(ids)]]}


class OriginCLI(fixtures.ImportCLI):
    def __init__(self):
        super().__init__()
        self.tamper = None

    def __call__(self, argv, **kwargs):
        if self.tamper and argv[2:4] == ["GET", "/open-apis/docx/v1/documents/Created/blocks"]:
            block = self.target[self.target["Created"]["children"][0]]
            if self.tamper == "link":
                run = next(element["text_run"] for element in block["text"]["elements"]
                           if element["text_run"].get("text_element_style", {}).get("link"))
                run["text_element_style"]["link"]["url"] = "https://example.com/wrong-source"
            elif self.tamper == "label":
                block["text"]["elements"][0]["text_run"]["content"] = "被替换的出处"
            elif self.tamper == "position":
                self.target["Created"]["children"].reverse()
            self.tamper = None
        return super().__call__(argv, **kwargs)


class SourceLinkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="feishu-source-link-test-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name).resolve() / "state"
        self.cli = OriginCLI()
        self.host = fixtures.native.NativeHost("/mock/lark-cli", self.directory, self.cli)
        self.operation = "source-link-operation"

    def call(self, action, **params):
        return self.host.handle({"action": action, "params": {"operation_id": self.operation, **params}})

    def prepare_web(self, value=None):
        value = value or snapshot()
        result = self.call("prepare_web_content", source_url=value["source_url"], snapshot=value)
        self.assertTrue(result["ok"], result)
        return self.host.content.read(self.operation)[2]

    def finish(self):
        for _ in range(100):
            result = self.call("import_step")
            self.assertTrue(result["ok"], result)
            if result["data"]["complete"]:
                return result
        self.fail("Import did not complete")

    def assert_origin(self, plan, url, hostname):
        self.assertEqual(set(plan["origin_link"]), {"url", "block_id"})
        self.assertEqual(plan["origin_link"]["url"], url)
        block_id = plan["origin_link"]["block_id"]
        self.assertEqual(plan["roots"][0], block_id)
        block = plan["blocks"][block_id]
        self.assertEqual(block["block_type"], 2)
        runs = [element["text_run"] for element in block["text"]["elements"]]
        self.assertEqual("".join(run["content"] for run in runs), "原文出处：" + hostname + " · 查看原文")
        links = [run for run in runs if run.get("text_element_style", {}).get("link")]
        self.assertEqual(len(links), 1)
        self.assertEqual(links[0]["content"], "查看原文")
        self.assertEqual(links[0]["text_element_style"]["link"]["url"], url)
        return block_id

    def test_web_origin_preserves_exact_query_fragment_and_all_original_blocks_in_first_batch(self):
        value = snapshot(3)
        original = copy.deepcopy(value)
        clean, roots, _, _ = self.host.content.sanitize(value["blocks"], "WebRoot")
        plan = self.prepare_web(value)
        origin_id = self.assert_origin(plan, WEB_URL, "scys.com")
        self.assertEqual({key: block for key, block in plan["blocks"].items() if key != origin_id}, clean)
        self.assertEqual(plan["roots"][1:], roots)
        self.assertEqual(value, original)
        self.assertEqual(len(plan["batches"]), 1)
        self.assertEqual(plan["batches"][0]["children_id"], [origin_id, *roots])
        self.finish()
        self.assertEqual(self.cli.target["Created"]["children"][0], "New" + origin_id)
        self.assertEqual(len(self.cli.target), len(value["blocks"]) + 1)
        writes = [argv for argv in self.cli.calls if argv[3].endswith("/descendant")]
        self.assertEqual(len(writes), 1, "the compact attribution shares the existing write batch")

    def test_native_origin_retains_original_wiki_or_docx_link_instead_of_rewriting_it_to_copy(self):
        for url in ("https://my.feishu.cn/wiki/OriginalWiki?from=share#Text",
                    "https://my.feishu.cn/docx/Source?from=share#Text",
                    "https://my.feishu.cn/docx/Source#Text"):
            with self.subTest(url=url):
                self.setUp()
                self.cli.source = [{"block_id": "Source", "block_type": 1, "children": ["Text"]}, fixtures.text("Text", "原文")]
                baseline = self.host.content.sanitize(self.cli.source, "Source")[0]
                result = self.call("prepare_content", token="Source", origin_url=url)
                self.assertTrue(result["ok"], result)
                plan = self.host.content.read(self.operation)[2]
                origin_id = self.assert_origin(plan, url, "my.feishu.cn")
                self.assertEqual(plan["blocks"]["Text"], baseline["Text"])
                self.finish()
                saved = self.cli.target["New" + origin_id]["text"]["elements"]
                actual = [element["text_run"]["text_element_style"]["link"]["url"] for element in saved
                          if element["text_run"].get("text_element_style", {}).get("link")]
                self.assertEqual(actual, [url])

    def test_full_200_descendant_batch_gets_one_preceding_attribution_batch(self):
        value = snapshot(199)
        before = self.host.content.build_web_plan(WEB_URL, value)
        self.assertEqual(len(before["batches"]), 1)
        self.assertEqual(len(before["batches"][0]["descendants"]), 200)
        plan = self.prepare_web(snapshot(200))
        origin_id = self.assert_origin(plan, WEB_URL, "scys.com")
        self.assertEqual([len(batch["descendants"]) for batch in plan["batches"]], [1, 200])
        self.assertEqual(plan["batches"][0]["children_id"], [origin_id])
        self.assertEqual([item for batch in plan["batches"] for item in batch["children_id"]], plan["roots"])

    def test_older_native_caller_without_origin_url_gets_the_original_docx_fallback(self):
        self.cli.source = [{"block_id": "Source", "block_type": 1, "children": ["Text"]}, fixtures.text("Text", "正文")]
        result = self.call("prepare_content", token="Source")
        self.assertTrue(result["ok"], result)
        self.assert_origin(self.host.content.read(self.operation)[2], "https://www.feishu.cn/docx/Source", "www.feishu.cn")

    def test_leading_native_bookmark_keeps_its_position_after_the_new_attribution(self):
        self.cli.source = [{"block_id": "Source", "block_type": 1, "children": ["Bookmark", "Text"]},
                           {"block_id": "Bookmark", "block_type": 999, "undefined": {}}, fixtures.text("Text", "正文")]
        self.cli.bookmarks["Bookmark"] = {"name": "原始卡片", "href": "https://example.com/article"}
        result = self.call("prepare_content", token="Source", origin_url="https://my.feishu.cn/wiki/OriginalWiki")
        self.assertTrue(result["ok"], result)
        plan = self.host.content.read(self.operation)[2]
        origin_id = self.assert_origin(plan, "https://my.feishu.cn/wiki/OriginalWiki", "my.feishu.cn")
        self.assertEqual(plan["batches"][0]["children_id"], [origin_id])
        self.assertEqual(plan["batches"][1]["bookmark"], self.cli.bookmarks["Bookmark"])
        self.finish()
        plan = self.host.content.read(self.operation)[2]
        self.assertEqual(self.cli.target["Created"]["children"], [plan["bindings"][item] for item in (origin_id, "Bookmark", "Text")])

    def test_prepare_restart_and_committed_batch_retry_never_duplicate_attribution(self):
        plan = self.prepare_web()
        original_plan = copy.deepcopy(plan)
        self.host = fixtures.native.NativeHost("/mock/lark-cli", self.directory, self.cli)
        self.assertEqual(self.prepare_web(), original_plan)
        for _ in range(5):
            if self.host.content.read(self.operation)[1].get("copied_token"):
                break
            self.assertTrue(self.call("import_step")["ok"])
        self.assertTrue(self.host.content.read(self.operation)[1].get("copied_token"))
        self.cli.failure = ("after", subprocess.TimeoutExpired([], 30))
        failed = self.call("import_step")
        self.assertTrue(failed.get("uncertain"), failed)
        first_write = copy.deepcopy(self.cli.calls[-1])
        self.host = fixtures.native.NativeHost("/mock/lark-cli", self.directory, self.cli)
        self.assertTrue(self.call("import_step")["ok"])
        self.assertEqual(self.cli.calls[-1], first_write)
        self.finish()
        origin_id = original_plan["origin_link"]["block_id"]
        self.assertEqual(self.cli.target["Created"]["children"].count("New" + origin_id), 1)
        self.assertEqual(self.host.content.read(self.operation)[2]["origin_link"], original_plan["origin_link"])

    def test_old_prepared_web_plan_without_origin_metadata_is_resumed_unchanged(self):
        value = snapshot(2)
        clean, roots, batches, images = self.host.content.sanitize(value["blocks"], "WebRoot")
        legacy = {"source": "WebRoot", "source_url": WEB_URL, "title": value["title"], "revision": None,
                  "create_marker": "飞书剪存-" + str(uuid.uuid4()), "blocks": clean, "roots": roots,
                  "batches": batches, "images": images, "batch_index": 0, "bindings": {},
                  "verified_blocks": [], "verify_page": "", "bookmarks": {}}
        record = {"mode": "content", "source": "WebRoot", "source_url": WEB_URL, "name": value["title"],
                  "stage": "content_prepared", "block_count": len(clean) + 1, "image_count": 0}
        self.host.content.save(self.operation, {self.operation: record}, legacy)
        self.assertEqual(self.prepare_web(value), legacy)
        self.finish()
        self.assertNotIn("origin_link", self.host.content.read(self.operation)[2])
        self.assertEqual(self.cli.target["Created"]["children"], ["New" + root for root in roots])
        self.assertEqual(len(self.cli.target), len(value["blocks"]))

    def test_old_native_plan_is_not_backfilled_when_a_new_worker_supplies_origin_url(self):
        source = [{"block_id": "Source", "block_type": 1, "children": ["Text"]}, fixtures.text("Text", "旧任务正文")]
        clean, roots, batches, images = self.host.content.sanitize(source, "Source")
        legacy = {"source": "Source", "title": "旧文章", "revision": 1,
                  "create_marker": "飞书剪存-" + str(uuid.uuid4()), "blocks": clean, "roots": roots,
                  "batches": batches, "images": images, "batch_index": 0, "bindings": {},
                  "verified_blocks": [], "verify_page": "", "bookmarks": {}}
        record = {"mode": "content", "source": "Source", "name": "旧文章", "stage": "content_prepared",
                  "block_count": len(clean) + 1, "image_count": 0}
        self.host.content.save(self.operation, {self.operation: record}, legacy)
        result = self.call("prepare_content", token="Source", origin_url="https://my.feishu.cn/wiki/OriginalWiki")
        self.assertTrue(result["ok"], result)
        self.assertEqual(self.host.content.read(self.operation)[2], legacy)
        self.assertFalse(self.cli.calls)
        self.finish()
        self.assertEqual(self.cli.target["Created"]["children"], ["NewText"])
        self.assertNotIn("origin_link", self.host.content.read(self.operation)[2])

    def test_tampered_origin_link_label_or_position_prevents_verified_success(self):
        for tamper in ("link", "label", "position"):
            with self.subTest(tamper=tamper):
                self.setUp()
                self.prepare_web()
                self.cli.tamper = tamper
                for _ in range(30):
                    result = self.call("import_step")
                    if not result["ok"]:
                        break
                    self.assertFalse(result["data"]["complete"], "tampered source attribution must not count as verified")
                self.assertEqual(result.get("code"), "CONTENT_MISMATCH", result)
                _, record, _ = self.host.content.read(self.operation)
                self.assertFalse(record.get("content_verified"))

    def test_source_attribution_does_not_raise_the_5000_input_block_limit(self):
        accepted = self.call("prepare_web_content", source_url=WEB_URL, snapshot=snapshot(4999))
        self.assertTrue(accepted["ok"], accepted)
        self.operation = "too-many-source-blocks"
        rejected = self.call("prepare_web_content", source_url=WEB_URL, snapshot=snapshot(5000))
        self.assertEqual(rejected.get("code"), "IMPORT_TOO_LARGE", rejected)
        self.assertFalse(self.cli.calls)


if __name__ == "__main__":
    unittest.main()
