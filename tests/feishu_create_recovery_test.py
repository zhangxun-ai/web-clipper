"""Create-response recovery regressions; all Feishu and CLI effects are simulated."""

import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import uuid


spec = importlib.util.spec_from_file_location(
    "create_recovery_fixtures", Path(__file__).with_name("feishu_content_import_test.py"))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)

DOCUMENTS = "/open-apis/docx/v1/documents"
FILES = "/open-apis/drive/v1/files"


class RecoveryCLI(fixtures.ImportCLI):
    """Expose a created document independently of whether its response arrived."""

    def __init__(self):
        super().__init__()
        self.title = None
        self.created = False
        self.create_response_lost = False
        self.create_commits = True
        self.rename_response_lost = False
        self.list_entries = None
        self.list_error = None
        self.metadata_override = {}
        self.response_overrides = {}

    def success(self, argv, data):
        overrides = self.response_overrides.get(tuple(argv[2:4]))
        if overrides:
            data = overrides.pop(0)
        return subprocess.CompletedProcess(
            argv, 0, json.dumps({"ok": True, "identity": "user", "data": data}), "")

    def __call__(self, argv, **kwargs):
        method, path = argv[2:4]
        handled = ((method, path) in {
            ("GET", FILES), ("GET", DOCUMENTS + "/Created"),
            ("POST", DOCUMENTS), ("PATCH", FILES + "/Created"),
        })
        if not handled:
            result = super().__call__(argv, **kwargs)
            if self.response_overrides.get((method, path)):
                return self.success(argv, json.loads(result.stdout)["data"])
            return result
        self.calls.append(argv)
        self.assert_user(argv)
        body = json.loads(argv[argv.index("--data") + 1]) if "--data" in argv else {}
        query = json.loads(argv[argv.index("--params") + 1]) if "--params" in argv else {}
        if (method, path) == ("GET", FILES):
            assert not query.get("folder_token"), "Recovery must list the creation directory"
            if self.list_error:
                return subprocess.CompletedProcess(argv, 3, "", json.dumps(self.list_error))
            entries = self.list_entries
            if entries is None:
                entries = ([{"name": self.title, "token": "Created", "type": "docx"}]
                           if self.created else [])
            return self.success(argv, {"files": copy.deepcopy(entries), "has_more": False})
        if (method, path) == ("POST", DOCUMENTS):
            self.title = body["title"]
            if self.create_commits:
                self.created = True
                self.target = {"Created": {"block_id": "Created", "block_type": 1, "children": []}}
            if self.create_response_lost:
                self.create_response_lost = False
                raise subprocess.TimeoutExpired(argv, 30)
            return self.success(argv, {"document": {"document_id": "Created", "title": self.title}})
        if (method, path) == ("GET", DOCUMENTS + "/Created"):
            document = {"document_id": "Created", "title": self.title, "revision_id": self.revision}
            document.update(self.metadata_override)
            return self.success(argv, {"document": document})
        assert query.get("type") == "docx"
        assert set(body) == {"new_title"}
        self.title = body["new_title"]
        if self.rename_response_lost:
            self.rename_response_lost = False
            raise subprocess.TimeoutExpired(argv, 30)
        return self.success(argv, {})


class CreateRecoveryTests(unittest.TestCase):
    def setUp(self):
        # This exact directory is disposable test state created by this test.
        self.temp = tempfile.TemporaryDirectory(prefix="feishu-create-recovery-test-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name).resolve() / "state"
        self.now = 1800000000.0
        clock = patch("time.time", side_effect=lambda: self.now)
        clock.start()
        self.addCleanup(clock.stop)
        self.cli = RecoveryCLI()
        self.host = fixtures.native.NativeHost("/mock/lark-cli", self.directory, self.cli)
        self.operation = "create-recovery-operation"
        self.source = {
            "title": "用户想保存的文章", "source_url": "https://scys.com/articleDetail/xq_topic/123456789",
            "blocks": [
                {"block_id": "WebRoot", "block_type": 1, "children": ["Text"]},
                {"block_id": "Text", "block_type": 2,
                 "text": {"elements": [{"text_run": {"content": "私有完整正文不要放进错误或进度"}}]}},
            ],
            "images": [],
        }

    def call(self, action, **params):
        return self.host.handle({"action": action, "params": {"operation_id": self.operation, **params}})

    def prepare(self):
        result = self.call("prepare_web_content", source_url=self.source["source_url"], snapshot=self.source)
        self.assertTrue(result["ok"], result)
        return result

    def step(self):
        count = len(self.cli.calls)
        result = self.call("import_step")
        self.assertLessEqual(len(self.cli.calls) - count, 1, "One import step exceeded one remote request")
        self.assertNotIn("私有完整正文不要放进错误或进度", json.dumps(result, ensure_ascii=False))
        return result

    def restart(self):
        self.host = fixtures.native.NativeHost("/mock/lark-cli", self.directory, self.cli)

    def requests(self, method, path):
        return [argv for argv in self.cli.calls if argv[2:4] == [method, path]]

    def marker(self):
        _, _, plan = self.host.content.read(self.operation)
        return plan["create_marker"]

    def advance(self, result):
        until = result.get("data", {}).get("deferred_until")
        if until is not None:
            self.now = max(self.now, until / 1000 + 0.001)

    def start_lost_create(self, commits=True):
        self.prepare()
        self.cli.create_response_lost = True
        self.cli.create_commits = commits
        for _ in range(5):
            result = self.step()
            if self.requests("POST", DOCUMENTS):
                break
            self.assertTrue(result["ok"], result)
        self.assertEqual(len(self.requests("POST", DOCUMENTS)), 1)
        self.assert_deferred(result)
        return result

    def assert_deferred(self, result):
        self.assertTrue(result["ok"], result)
        self.assertFalse(result["data"]["complete"])
        self.assertEqual(result["data"]["progress"]["phase"], "content_recovering")
        self.assertGreater(result["data"]["deferred_until"], self.now * 1000)

    def finish(self, limit=30):
        for _ in range(limit):
            result = self.step()
            self.assertTrue(result["ok"], result)
            if result["data"]["complete"]:
                return result
            self.advance(result)
        self.fail("Import did not finish within its bounded protocol steps")

    def assert_recovery_rejected(self, mutate):
        result = self.start_lost_create()
        mutate()
        self.advance(result)
        for _ in range(8):
            result = self.step()
            if not result["ok"]:
                break
            self.assertFalse(result["data"]["complete"])
            self.advance(result)
        self.assertFalse(result["ok"], result)
        _, record, plan = self.host.content.read(self.operation)
        self.assertFalse(record.get("copied_token"))
        self.assertFalse(record.get("content_verified"))
        self.assertEqual(plan["batch_index"], 0)
        self.assertEqual(len(self.requests("POST", DOCUMENTS)), 1)
        self.assertFalse(any(argv[2] != "GET" and argv[3] != DOCUMENTS for argv in self.cli.calls))

    def test_prepared_marker_is_uuid_persistent_and_not_supplied_by_page(self):
        self.prepare()
        marker = self.marker()
        self.assertTrue(marker.startswith("飞书剪存-"))
        self.assertEqual(uuid.UUID(marker.removeprefix("飞书剪存-")).version, 4)
        self.assertEqual(self.cli.calls, [])
        self.restart()
        self.prepare()
        self.assertEqual(self.marker(), marker)
        self.assertEqual(self.cli.calls, [])

    def test_feishu_source_prepare_also_persists_marker(self):
        result = self.call("prepare_content", token="Source")
        self.assertTrue(result["ok"], result)
        self.assertEqual(uuid.UUID(self.marker().removeprefix("飞书剪存-")).version, 4)

    def test_missing_listing_scope_is_found_before_create(self):
        self.prepare()
        self.cli.list_error = {"ok": False, "error": {"type": "authorization", "subtype": "missing_scope",
            "code": 99991679, "missing_scopes": ["space:document:retrieve"],
            "message": "missing permission scope space:document:retrieve"}}
        result = self.step()
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "MISSING_SCOPE")
        self.assertEqual(len(self.requests("GET", FILES)), 1)
        self.assertEqual(self.requests("POST", DOCUMENTS), [])

    def test_successful_create_uses_marker_then_restores_title_before_completion(self):
        self.prepare()
        marker = self.marker()
        first = self.step()
        self.assertTrue(first["ok"], first)
        self.assertEqual(self.cli.calls[-1][2:4], ["GET", FILES])
        self.assertEqual(self.requests("POST", DOCUMENTS), [])
        result = self.finish()
        create = self.requests("POST", DOCUMENTS)
        self.assertEqual(len(create), 1)
        self.assertEqual(json.loads(create[0][create[0].index("--data") + 1])["title"], marker)
        self.assertEqual(self.cli.title, self.source["title"])
        self.assertEqual(result["data"]["document"]["name"], self.source["title"])
        self.assertEqual(len(self.requests("PATCH", FILES + "/Created")), 1)
        self.assertEqual(self.cli.calls[-1][2:4], ["GET", DOCUMENTS + "/Created"])
        self.assertFalse(any(argv[2] != "GET" and "/WebRoot" in argv[3] for argv in self.cli.calls))

    def test_lost_create_response_recovers_by_exact_marker_and_empty_root_after_restart(self):
        result = self.start_lost_create()
        self.assertNotEqual(self.cli.title, self.source["title"])
        self.restart()
        self.advance(result)
        count = len(self.cli.calls)
        for expected in (["GET", FILES], ["GET", DOCUMENTS + "/Created"],
                         ["GET", DOCUMENTS + "/Created/blocks"]):
            result = self.step()
            self.assertTrue(result["ok"], result)
            self.assertEqual(self.cli.calls[-1][2:4], expected)
        self.assertEqual(len(self.cli.calls) - count, 3)
        _, record, _ = self.host.content.read(self.operation)
        self.assertEqual(record["copied_token"], "Created")
        self.assertEqual(self.cli.target["Created"]["children"], [])
        self.finish()
        self.assertEqual(len(self.requests("POST", DOCUMENTS)), 1)
        self.assertEqual(self.cli.target["Created"]["children"], ["NewText"])

    def test_absent_marker_defers_without_recreate_then_stops_after_five_minutes(self):
        result = self.start_lost_create(commits=False)
        # An original-title match and a marker prefix are not operation identity.
        self.cli.list_entries = [
            {"name": self.source["title"], "token": "Unrelated", "type": "docx"},
            {"name": self.marker() + "suffix", "token": "PrefixOnly", "type": "docx"},
        ]
        self.advance(result)
        for _ in range(3):
            result = self.step()
            self.assert_deferred(result)
            self.advance(result)
        self.now += 301
        result = self.step()
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "CREATE_UNCERTAIN")
        self.assertEqual(len(self.requests("POST", DOCUMENTS)), 1)
        self.assertTrue(all(argv[3] in (DOCUMENTS, FILES) for argv in self.cli.calls))

    def test_marker_matching_multiple_documents_is_not_arbitrarily_claimed(self):
        def mutate():
            self.cli.list_entries = [{"name": self.marker(), "token": token, "type": "docx"}
                                     for token in ("Created", "OtherCreated")]
        self.assert_recovery_rejected(mutate)

    def test_marker_with_wrong_file_type_is_not_claimed(self):
        def mutate():
            self.cli.list_entries = [{"name": self.marker(), "token": "Created", "type": "sheet"}]
        self.assert_recovery_rejected(mutate)

    def test_marker_matching_source_token_is_not_claimed(self):
        def mutate():
            self.cli.list_entries = [{"name": self.marker(), "token": "WebRoot", "type": "docx"}]
        self.assert_recovery_rejected(mutate)

    def test_nonempty_document_is_not_claimed_or_overwritten(self):
        def mutate():
            self.cli.target["Created"]["children"] = ["SomebodyElsesContent"]
        self.assert_recovery_rejected(mutate)

    def test_unattached_extra_block_also_prevents_claiming_apparently_empty_root(self):
        def mutate():
            self.cli.target["Unattached"] = {"block_id": "Unattached", "block_type": 2,
                                              "text": {"elements": []}}
        self.assert_recovery_rejected(mutate)

    def test_title_changed_between_listing_and_metadata_is_not_claimed(self):
        def mutate():
            self.cli.metadata_override["title"] = "用户已经改过标题"
        self.assert_recovery_rejected(mutate)

    def test_legacy_uncertain_plan_without_marker_never_replays_create(self):
        self.prepare()
        journal, record, plan = self.host.content.read(self.operation)
        plan.pop("create_marker", None)
        record["stage"] = "content_create_uncertain"
        self.host.content.save(self.operation, journal, plan)
        self.restart()
        for _ in range(3):
            result = self.step()
            self.assertFalse(result["ok"], result)
            self.assertEqual(result["code"], "CREATE_UNCERTAIN")
        self.assertEqual(self.cli.calls, [])

    def test_lost_rename_response_reuses_same_document_and_same_title(self):
        self.prepare()
        self.cli.rename_response_lost = True
        for _ in range(30):
            result = self.step()
            if self.requests("PATCH", FILES + "/Created"):
                break
            self.assertTrue(result["ok"], result)
            self.advance(result)
        self.assertEqual(len(self.requests("PATCH", FILES + "/Created")), 1)
        self.assertFalse(result.get("data", {}).get("complete"))
        if not result["ok"]:
            self.assertTrue(result.get("retryable"), result)
        self.restart()
        self.advance(result)
        self.finish()
        self.assertEqual(len(self.requests("POST", DOCUMENTS)), 1)
        self.assertEqual(self.cli.title, self.source["title"])
        for argv in self.requests("PATCH", FILES + "/Created"):
            self.assertEqual(json.loads(argv[argv.index("--data") + 1]), {"new_title": self.source["title"]})
        self.assertEqual(self.cli.calls[-1][2:4], ["GET", DOCUMENTS + "/Created"])

    def test_invalid_created_document_objects_enter_marker_recovery_without_recreate(self):
        for index, malformed in enumerate((None, [], "invalid")):
            with self.subTest(document=malformed):
                self.operation = "malformed-create-" + str(index)
                self.cli = RecoveryCLI()
                self.restart()
                self.prepare()
                self.cli.response_overrides[("POST", DOCUMENTS)] = [{"document": malformed}]
                self.assertTrue(self.step()["ok"])
                result = self.step()
                self.assertTrue(self.cli.created)
                self.assert_deferred(result)
                self.assertFalse(self.host.content.read(self.operation)[1].get("copied_token"))
                self.restart()
                self.advance(result)
                self.finish()
                self.assertEqual(len(self.requests("POST", DOCUMENTS)), 1)

    def test_invalid_recovery_metadata_is_retried_before_claiming_document(self):
        result = self.start_lost_create()
        self.advance(result)
        self.assertTrue(self.step()["ok"])  # List the matching marker.
        self.cli.response_overrides[("GET", DOCUMENTS + "/Created")] = [
            {"document": None}, {"document": []},
        ]
        for _ in range(2):
            result = self.step()
            self.assertFalse(result["ok"], result)
            self.assertEqual(result["code"], "INVALID_RESPONSE")
            self.assertTrue(result.get("retryable"))
            _, record, plan = self.host.content.read(self.operation)
            self.assertFalse(record.get("copied_token"))
            self.assertFalse(plan.get("create_candidate_checked"))
            self.assertEqual(self.cli.target["Created"]["children"], [])
        self.finish()
        self.assertEqual(len(self.requests("POST", DOCUMENTS)), 1)

    def test_invalid_recovery_root_objects_are_retried_without_claim_or_content_write(self):
        result = self.start_lost_create()
        self.advance(result)
        self.assertTrue(self.step()["ok"])  # List the matching marker.
        self.assertTrue(self.step()["ok"])  # Check its metadata.
        self.cli.response_overrides[("GET", DOCUMENTS + "/Created/blocks")] = [
            {"items": [None], "has_more": False}, {"items": [[]], "has_more": False},
        ]
        for _ in range(2):
            result = self.step()
            self.assertFalse(result["ok"], result)
            self.assertEqual(result["code"], "INVALID_RESPONSE")
            self.assertTrue(result.get("retryable"))
            _, record, plan = self.host.content.read(self.operation)
            self.assertFalse(record.get("copied_token"))
            self.assertEqual(plan["batch_index"], 0)
        self.finish()
        self.assertEqual(len(self.requests("POST", DOCUMENTS)), 1)

    def test_invalid_final_title_metadata_never_marks_complete_or_rewrites_content(self):
        self.prepare()
        for _ in range(20):
            result = self.step()
            self.assertTrue(result["ok"], result)
            if self.requests("PATCH", FILES + "/Created"):
                break
        self.assertEqual(len(self.requests("PATCH", FILES + "/Created")), 1)
        self.cli.response_overrides[("GET", DOCUMENTS + "/Created")] = [
            {"document": None}, {"document": []},
        ]
        content_before = copy.deepcopy(self.cli.target)
        for _ in range(2):
            result = self.step()
            self.assertFalse(result["ok"], result)
            self.assertEqual(result["code"], "INVALID_RESPONSE")
            self.assertTrue(result.get("retryable"))
            _, record, plan = self.host.content.read(self.operation)
            self.assertFalse(record.get("content_verified"))
            self.assertFalse(plan.get("title_verified"))
            self.assertEqual(self.cli.target, content_before)
        self.finish()
        self.assertEqual(len(self.requests("POST", DOCUMENTS)), 1)
        self.assertEqual(len(self.requests("PATCH", FILES + "/Created")), 1)

    def test_explicit_retry_preserves_staged_content_and_safe_prior_attempt_summary(self):
        self.assertTrue(self.call("prepare_content", token="Source")["ok"])
        image = b"\x89PNG\r\n\x1a\n" + b"staged original image"
        self.assertTrue(self.call("stage_image", block_id="Image", offset=0, total_size=len(image),
            mime_type="image/png", data_base64=fixtures.base64.b64encode(image).decode())["ok"])
        journal, record, plan = self.host.content.read(self.operation)
        plan.pop("create_marker")  # This is a legacy request, sent before correlation markers existed.
        plan.update({"create_preflight": True, "create_next_check": self.now + 5,
                     "create_requested_at": self.now - 100, "create_error_code": "CLI_NETWORK"})
        record["stage"] = "content_create_uncertain"
        record["last_error"] = {"code": "CLI_NETWORK", "phase": "content_create_uncertain",
                                "at": "2026-09-08T08:47:17Z", "uncertain": True,
                                "message": "private raw diagnostic", "body": "private raw content"}
        self.host.content.save(self.operation, journal, plan)
        body_before = {key: copy.deepcopy(plan[key]) for key in (
            "source", "title", "blocks", "roots", "batches", "images", "batch_index", "bindings")}
        calls_before = len(self.cli.calls)
        result = self.call("retry_content_creation", request_id="explicit-save-request-1")
        self.assertTrue(result["ok"], result)
        self.assertFalse(result["data"]["already_applied"])
        self.assertEqual(result["data"]["stage"], "content_prepared")
        self.assertEqual(len(self.cli.calls), calls_before)
        _, record, plan = self.host.content.read(self.operation)
        self.assertEqual({key: plan[key] for key in body_before}, body_before)
        self.assertEqual(self.host.content.image_path(self.operation, "Image").read_bytes(), image)
        self.assertEqual(uuid.UUID(plan["create_marker"].removeprefix("飞书剪存-")).version, 4)
        self.assertNotIn("create_preflight", plan)
        self.assertNotIn("create_next_check", plan)
        self.assertNotIn("last_error", record)
        history = record["create_attempt_history"]
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["stage"], "content_create_uncertain")
        self.assertEqual(history[0]["error"]["code"], "CLI_NETWORK")
        self.assertNotIn("private raw", json.dumps(history))
        self.assertNotIn("private raw", json.dumps(result))

    def test_repeated_user_intent_does_not_reset_started_or_completed_new_attempt(self):
        self.start_lost_create(commits=False)
        previous_marker = self.marker()
        request_id = "explicit-save-request-2"
        self.assertTrue(self.call("retry_content_creation", request_id=request_id)["ok"])
        new_marker = self.marker()
        self.assertNotEqual(new_marker, previous_marker)
        self.cli.create_commits = True
        self.cli.create_response_lost = True
        self.assertTrue(self.step()["ok"])  # New attempt gets its own preflight.
        deferred = self.step()
        self.assert_deferred(deferred)
        calls_before = len(self.cli.calls)
        repeated = self.call("retry_content_creation", request_id=request_id)
        self.assertTrue(repeated["ok"], repeated)
        self.assertTrue(repeated["data"]["already_applied"])
        self.assertEqual(self.marker(), new_marker)
        self.assertEqual(len(self.cli.calls), calls_before)
        self.assertEqual(repeated["data"]["stage"], "content_recovering")
        self.restart()
        self.advance(deferred)
        self.finish()
        repeated = self.call("retry_content_creation", request_id=request_id)
        self.assertTrue(repeated["ok"], repeated)
        self.assertTrue(repeated["data"]["already_applied"])
        self.assertEqual(self.marker(), new_marker)
        self.assertEqual(len(self.requests("POST", DOCUMENTS)), 2)
        _, record, _ = self.host.content.read(self.operation)
        self.assertTrue(record["content_verified"])
        self.assertEqual(record["copied_token"], "Created")
        self.assertEqual(len(record["create_attempt_history"]), 1)
        self.assertEqual(record["create_attempt_history"][0]["marker"], previous_marker)

    def test_new_retry_intent_is_refused_for_unstarted_or_already_claimed_document(self):
        self.prepare()
        result = self.call("retry_content_creation", request_id="unnecessary-request-1")
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "CREATE_RETRY_FORBIDDEN")
        self.finish()
        calls_before = len(self.cli.calls)
        marker = self.marker()
        result = self.call("retry_content_creation", request_id="unnecessary-request-2")
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "CREATE_RETRY_FORBIDDEN")
        self.assertEqual(len(self.cli.calls), calls_before)
        self.assertEqual(self.marker(), marker)
        self.assertEqual(len(self.requests("POST", DOCUMENTS)), 1)

    def test_crash_during_retry_plan_reset_is_finished_before_any_new_remote_request(self):
        self.start_lost_create(commits=False)
        old_marker = self.marker()
        write = self.host.store.write
        def crash_on_plan(name, value):
            if name == self.host.content.plan_name(self.operation):
                raise OSError("simulated process interruption while writing reset plan")
            return write(name, value)
        with patch.object(self.host.store, "write", side_effect=crash_on_plan):
            result = self.call("retry_content_creation", request_id="crash-safe-user-request")
        self.assertFalse(result["ok"])
        journal = self.host.store.read("operations.json", {})
        self.assertTrue(journal[self.operation]["creation_retry"]["pending"])
        new_marker = journal[self.operation]["creation_retry"]["marker"]
        self.assertNotEqual(new_marker, old_marker)
        self.restart()
        count = len(self.cli.calls)
        result = self.step()
        self.assertTrue(result["ok"], result)
        self.assertEqual(len(self.cli.calls), count)
        self.assertEqual(result["data"]["stage"], "content_prepared")
        self.assertEqual(self.marker(), new_marker)
        repeated = self.call("retry_content_creation", request_id="crash-safe-user-request")
        self.assertTrue(repeated["ok"], repeated)
        self.assertTrue(repeated["data"]["already_applied"])
        self.assertEqual(self.marker(), new_marker)
        self.cli.create_commits = True
        self.finish()
        self.assertEqual(len(self.requests("POST", DOCUMENTS)), 2)


if __name__ == "__main__":
    unittest.main()
