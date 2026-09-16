"""Refresh only an unwritten browser snapshot; real Feishu is never contacted."""

import base64
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "web_refresh_fixtures", Path(__file__).with_name("feishu_create_recovery_test.py"))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)


class WebRefreshTests(unittest.TestCase):
    def setUp(self):
        # This directory contains only disposable state created by this test.
        self.temp = tempfile.TemporaryDirectory(prefix="feishu-web-refresh-test-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name).resolve() / "state"
        self.cli = fixtures.RecoveryCLI()
        self.host = fixtures.fixtures.native.NativeHost("/mock/lark-cli", self.directory, self.cli)
        self.operation = "web-refresh-operation"
        self.source_url = "https://scys.com/articleDetail/xq_topic/22255154882458281"
        self.snapshot = {"title": "文章里的人员提及", "source_url": self.source_url,
            "blocks": [
                {"block_id": "WebRoot", "block_type": 1, "children": ["Text", "Image"]},
                {"block_id": "Text", "block_type": 2,
                 "text": {"elements": [{"text_run": {"content": "正文内容"}}]}},
                {"block_id": "Image", "block_type": 27, "image": {"token": "Image"}},
            ],
            "images": [{"block_id": "Image", "url":
                "https://scys.com/articleDetail/xq_topic/ou_" + "a" * 32}],
        }

    def call(self, action, **params):
        return self.host.handle({"action": action, "params": {"operation_id": self.operation, **params}})

    def prepare(self):
        result = self.call("prepare_web_content", source_url=self.source_url, snapshot=self.snapshot)
        self.assertTrue(result["ok"], result)
        return result

    def corrected(self):
        snapshot = copy.deepcopy(self.snapshot)
        snapshot["blocks"][0]["children"] = ["Text"]
        snapshot["blocks"] = snapshot["blocks"][:2]
        snapshot["blocks"][1]["text"]["elements"][0]["text_run"]["content"] += " @被提及的人"
        snapshot["images"] = []
        return snapshot

    def refresh(self, request_id="snapshot-refresh-request", snapshot=None):
        return self.call("refresh_web_content", source_url=self.source_url, request_id=request_id,
                         snapshot=self.corrected() if snapshot is None else snapshot)

    def plan_bytes(self):
        return self.host.store.file(self.host.content.plan_name(self.operation)).read_bytes()

    def test_known_stale_scys_snapshot_requests_recapture_without_silently_changing_content(self):
        result = self.prepare()
        self.assertTrue(result["data"].get("refresh_required"))
        self.assertEqual(result["data"]["image_count"], 1)
        original = self.plan_bytes()
        result = self.call("prepare_web_content", source_url=self.source_url)
        self.assertTrue(result["data"].get("refresh_required"))
        self.assertEqual(self.plan_bytes(), original)
        self.assertEqual(self.cli.calls, [])

    def test_marker_requires_known_scys_source_and_exact_bad_image_path(self):
        for index, (source, image_url) in enumerate((
            ("https://example.com/article", self.snapshot["images"][0]["url"]),
            (self.source_url, "https://images.scys.com/ou_" + "a" * 32 + ".png"),
            (self.source_url, "https://scys.com/articleDetail/xq_topic/ou_not_a_user_token"),
        )):
            with self.subTest(source=source, image_url=image_url):
                self.operation = "other-snapshot-" + str(index)
                snapshot = copy.deepcopy(self.snapshot)
                snapshot["source_url"] = source
                snapshot["images"][0]["url"] = image_url
                result = self.call("prepare_web_content", source_url=source, snapshot=snapshot)
                self.assertTrue(result["ok"], result)
                self.assertFalse(result["data"].get("refresh_required"))

    def test_valid_refresh_preserves_old_snapshot_history_and_deduplicates_after_creation(self):
        self.prepare()
        original = json.loads(self.plan_bytes())
        journal, record, _ = self.host.content.read(self.operation)
        record["error_history"] = [{"code": "IMAGE_HTTP_400"}]
        record["create_attempt_history"] = [{"stage": "older_attempt"}]
        self.host.store.write("operations.json", journal)
        result = self.refresh()
        self.assertTrue(result["ok"], result)
        self.assertFalse(result["data"]["already_applied"])
        self.assertFalse(result["data"].get("refresh_required"))
        self.assertEqual(result["data"]["image_count"], 0)
        self.assertEqual(result["data"]["block_count"], 3)
        self.assertEqual(self.cli.calls, [])
        _, record, plan = self.host.content.read(self.operation)
        origin = fixtures.fixtures.assert_origin_paragraph(self, plan, self.source_url)
        self.assertEqual(plan["roots"], [origin, "Text"])
        self.assertEqual(set(plan["blocks"]), {origin, "Text"})
        self.assertEqual(plan["blocks"]["Text"]["text"], self.corrected()["blocks"][1]["text"])
        self.assertEqual(record["error_history"], [{"code": "IMAGE_HTTP_400"}])
        self.assertEqual(record["create_attempt_history"], [{"stage": "older_attempt"}])
        backup = record["snapshot_refresh_history"][0]["backup_name"]
        self.assertEqual(self.host.store.read(backup, {}), original)
        for _ in range(20):
            result = self.call("import_step")
            self.assertTrue(result["ok"], result)
            if result["data"]["complete"]:
                break
        self.assertTrue(result["data"]["complete"])
        _, _, imported = self.host.content.read(self.operation)
        saved_origin = fixtures.fixtures.assert_origin_paragraph(self, imported, self.source_url, self.cli.target)
        self.assertEqual(self.cli.target["Created"]["children"], [saved_origin, "NewText"])
        completed = self.plan_bytes()
        calls = len(self.cli.calls)
        result = self.refresh(snapshot={"invalid": "an old repeated message cannot overwrite progress"})
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["data"]["already_applied"])
        self.assertEqual(self.plan_bytes(), completed)
        self.assertEqual(len(self.cli.calls), calls)
        self.assertEqual(len(self.host.content.read(self.operation)[1]["snapshot_refresh_history"]), 1)

    def test_invalid_snapshot_is_rejected_before_backup_or_plan_change(self):
        self.prepare()
        original = self.plan_bytes()
        files = sorted(path.name for path in self.directory.iterdir())
        invalid = self.corrected()
        invalid["blocks"][0]["children"] = ["Missing"]
        result = self.refresh(snapshot=invalid)
        self.assertFalse(result["ok"])
        self.assertEqual(self.plan_bytes(), original)
        self.assertEqual(sorted(path.name for path in self.directory.iterdir()), files)
        self.assertEqual(self.cli.calls, [])

    def test_changed_source_is_rejected_without_overwriting_snapshot(self):
        self.prepare()
        original = self.plan_bytes()
        result = self.call("refresh_web_content", source_url="https://scys.com/articleDetail/xq_topic/999",
                           request_id="wrong-source-request", snapshot=self.corrected())
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "OPERATION_CONFLICT")
        self.assertEqual(self.plan_bytes(), original)

    def test_partial_and_complete_image_staging_both_prevent_snapshot_refresh(self):
        data = b"\x89PNG\r\n\x1a\n" + b"original staged bytes"
        for index, size in enumerate((8, len(data))):
            with self.subTest(staged_bytes=size):
                self.operation = "staged-image-operation-" + str(index)
                self.prepare()
                result = self.call("stage_image", block_id="Image", offset=0, total_size=len(data),
                    mime_type="image/png", data_base64=base64.b64encode(data[:size]).decode(), pixel_width=100, pixel_height=50)
                self.assertTrue(result["ok"], result)
                original = self.plan_bytes()
                summary = self.call("prepare_web_content", source_url=self.source_url)
                self.assertFalse(summary["data"].get("refresh_required"))
                result = self.refresh()
                self.assertFalse(result["ok"])
                self.assertEqual(result["code"], "SNAPSHOT_REFRESH_FORBIDDEN")
                self.assertEqual(self.plan_bytes(), original)
                self.assertEqual(self.host.content.image_path(self.operation, "Image").read_bytes(), data[:size])

    def test_unknown_creation_known_document_and_partial_import_progress_are_preserved(self):
        variants = (
            ({"stage": "content_create_uncertain"}, {}),
            ({"copied_token": "Created"}, {}),
            ({}, {"create_requested_at": 0}),
            ({}, {"batch_index": 1}),
            ({}, {"bindings": {"Text": "NewText"}}),
        )
        for index, (record_patch, plan_patch) in enumerate(variants):
            with self.subTest(record=record_patch, plan=plan_patch):
                self.operation = "protected-progress-" + str(index)
                self.prepare()
                journal, record, plan = self.host.content.read(self.operation)
                record.update(record_patch)
                plan.update(plan_patch)
                self.host.content.save(self.operation, journal, plan)
                original = self.plan_bytes()
                result = self.refresh()
                self.assertFalse(result["ok"])
                self.assertEqual(result["code"], "SNAPSHOT_REFRESH_FORBIDDEN")
                self.assertEqual(self.plan_bytes(), original)
        self.assertEqual(self.cli.calls, [])

    def test_crash_during_refresh_is_reconciled_by_read_without_remote_side_effects(self):
        self.prepare()
        original = json.loads(self.plan_bytes())
        write = self.host.store.write
        def crash_on_active_plan(name, value):
            if name == self.host.content.plan_name(self.operation):
                raise OSError("simulated crash after refresh intent was saved")
            return write(name, value)
        with patch.object(self.host.store, "write", side_effect=crash_on_active_plan):
            result = self.refresh()
        self.assertFalse(result["ok"])
        journal = self.host.store.read("operations.json", {})
        self.assertTrue(journal[self.operation]["snapshot_refresh"]["pending"])
        self.host = fixtures.fixtures.native.NativeHost("/mock/lark-cli", self.directory, self.cli)
        result = self.call("prepare_web_content", source_url=self.source_url)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["data"]["image_count"], 0)
        self.assertFalse(result["data"].get("refresh_required"))
        self.assertEqual(self.cli.calls, [])
        _, record, plan = self.host.content.read(self.operation)
        self.assertFalse(record["snapshot_refresh"]["pending"])
        backup = record["snapshot_refresh_history"][0]["backup_name"]
        self.assertEqual(self.host.store.read(backup, {}), original)
        active = self.plan_bytes()
        result = self.refresh()
        self.assertTrue(result["data"]["already_applied"])
        self.assertEqual(self.plan_bytes(), active)
        self.assertEqual(len(record["snapshot_refresh_history"]), 1)


if __name__ == "__main__":
    unittest.main()
