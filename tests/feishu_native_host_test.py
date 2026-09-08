"""Native host contract and recovery tests. No network, login, or Feishu writes."""

import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import struct
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


host_module = load("feishu_native_host", ROOT / "helper/feishu_native_host.py")
installer = load("install_feishu_native_host", ROOT / "helper/install_feishu_native_host.py")


class FakeCLI:
    def __init__(self):
        self.calls = []
        self.responses = []

    def success(self, data, legacy=False):
        envelope = {"code": 0, "data": data} if legacy else {"ok": True, "identity": "user", "data": data}
        self.responses.append(subprocess.CompletedProcess([], 0, json.dumps(envelope), ""))
        return self

    def direct(self, data):
        self.responses.append(subprocess.CompletedProcess([], 0, json.dumps(data), ""))
        return self

    def failure(self, error, code=1, stdout=False):
        raw = json.dumps(error)
        self.responses.append(subprocess.CompletedProcess([], code, raw if stdout else "", "" if stdout else raw))
        return self

    def __call__(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        if not self.responses:
            raise AssertionError("Unexpected CLI call")
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


class HostTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="feishu-host-test-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name).resolve() / "state"
        self.cli = FakeCLI()
        self.host = host_module.NativeHost("/test/lark-cli", self.directory, self.cli)
        self.source, self.copy, self.parent = "SourceDocx123", "CopiedDocx456", "ParentWiki789"
        self.operation = "test-operation-123"

    def call(self, action, **params):
        return self.host.handle({"action": action, "params": params})

    def copy_success(self):
        self.cli.success({"auth_result": True}).success({"token": "RootFolder123"})
        self.cli.success({"file": {"token": self.copy, "name": "原文标题", "type": "docx",
                                   "url": "https://example.feishu.cn/docx/" + self.copy,
                                   "access_token": "MUST_NOT_LEAK"}})
        result = self.call("copy_doc", token=self.source, name="原文标题", operation_id=self.operation)
        self.assertTrue(result["ok"], result)
        return result

    def move(self):
        return self.call("move_doc", obj_token=self.copy, space_id="123456789",
                         parent_node_token=self.parent, operation_id=self.operation)

    def parent_success(self):
        self.cli.success({"node": {"space_id": "123456789", "node_token": self.parent}})

    def test_whitelist_rejects_unknown_or_extra_request_fields(self):
        for message in ({"action": "delete"}, {"action": "status", "params": {"command": "rm"}},
                        {"action": "status", "command": "rm"}, [], {"action": [], "params": {}}):
            self.assertFalse(self.host.handle(message)["ok"])
        self.assertEqual(self.cli.calls, [])

    def test_operation_lookup_is_filtered_local_evidence_and_never_replays_writes(self):
        record = {"mode": "content", "source": "WebRoot",
                  "source_url": "https://scys.com/articleDetail/xq_topic/22255154882458281",
                  "stage": "moved", "content_verified": True, "copied_token": self.copy,
                  "target": {"space_id": "123456789", "parent_node_token": self.parent},
                  "move_result": {"wiki_token": "SavedWiki123"},
                  "name": "PRIVATE_BODY", "file": {"access_token": "MUST_NOT_LEAK"},
                  "error_history": [{"error": "PRIVATE_CLI_OUTPUT"}]}
        self.host.store.write("operations.json", {self.operation: record})
        before = (self.directory / "operations.json").read_bytes()
        result = self.call("get_operation", operation_id=self.operation)
        self.assertEqual(result, {"ok": True, "data": {
            "found": True, "source_token": "WebRoot", "source_url": record["source_url"],
            "phase": "moved", "content_verified": True, "document": {"token": self.copy},
            "target": record["target"], "wiki_token": "SavedWiki123"}})
        self.assertEqual((self.directory / "operations.json").read_bytes(), before)
        self.assertEqual(self.cli.calls, [])

    def test_operation_lookup_does_not_infer_success_from_incomplete_or_missing_journal(self):
        self.assertEqual(self.call("get_operation", operation_id=self.operation),
                         {"ok": True, "data": {"found": False}})
        for stage in ("content_create_uncertain", "content_verifying", "moving", "move_uncertain"):
            with self.subTest(stage=stage):
                self.host.store.write("operations.json", {self.operation: {
                    "mode": "content", "source": "Source123", "stage": stage,
                    "content_verified": False, "move_result": {"wiki_token": "SavedWiki123"}}})
                result = self.call("get_operation", operation_id=self.operation)["data"]
                self.assertFalse(result["content_verified"])
                self.assertNotIn("wiki_token", result)
                self.assertNotIn("document", result)
        self.assertEqual(self.cli.calls, [])

    def test_operation_lookup_rejects_invalid_records_without_mutating_journal(self):
        self.host.store.write("operations.json", {self.operation: {
            "mode": "content", "source": self.source, "copied_token": self.source, "stage": "moved"}})
        before = (self.directory / "operations.json").read_bytes()
        self.assertEqual(self.call("get_operation", operation_id=self.operation)["code"], "STATE_ERROR")
        self.assertEqual(self.call("get_operation", operation_id="../../operations")["code"], "INVALID_PARAMS")
        self.assertEqual(self.call("get_operation", operation_id=self.operation, path="/tmp")["code"], "INVALID_PARAMS")
        self.assertEqual((self.directory / "operations.json").read_bytes(), before)
        self.assertEqual(self.cli.calls, [])

    def test_schema_rejection_is_not_reported_as_unknown_creation_outcome(self):
        error = host_module.cli_error("", json.dumps({"error": {"type": "api", "code": 1770041,
                                      "message": "open schema mismatch PRIVATE"}}), 1, write=True)
        self.assertEqual(error.code, "1770041")
        self.assertFalse(error.uncertain)
        self.assertIn("嵌套结构", str(error))
        self.assertNotIn("PRIVATE", str(error))

    def test_transient_read_errors_can_retry_but_permissions_cannot(self):
        for code in (1771001, 1771002, 1771005, 99991400):
            self.cli.failure({"code": code, "msg": "PRIVATE"})
            result = self.call("get_document", token=self.source)
            self.assertTrue(result["retryable"])
            self.assertNotIn("PRIVATE", json.dumps(result))
        self.cli.failure({"code": 1770032, "msg": "PRIVATE"})
        result = self.call("get_document", token=self.source)
        self.assertEqual(result["code"], "PERMISSION_DENIED")
        self.assertNotIn("retryable", result)

    def test_busy_lock_reports_safe_retry_without_sending_a_request(self):
        with self.host.store.locked():
            result = self.call("get_document", token=self.source)
        self.assertEqual(result["code"], "BUSY")
        self.assertTrue(result["retryable"])
        self.assertEqual(self.cli.calls, [])

    def test_path_and_argument_injection_rejected_before_cli(self):
        for token in ("../delete", "x/copy", "x?token=secret", "$(id)", "x\n", ["x"], None):
            result = self.call("get_document", token=token)
            self.assertEqual(result["code"], "INVALID_PARAMS")
        for params in ({"page_token": False}, {"page_token": "x\n"}):
            self.assertEqual(self.call("list_spaces", **params)["code"], "INVALID_PARAMS")
        self.assertEqual(self.cli.calls, [])

    def test_title_utf8_limit_and_operation_id(self):
        for name in ("", "字" * 86, "x\n"):
            self.assertEqual(self.call("copy_doc", token=self.source, name=name,
                                       operation_id=self.operation)["code"], "INVALID_PARAMS")
        self.assertEqual(self.call("copy_doc", token=self.source, name="title",
                                   operation_id="../foo")["code"], "INVALID_PARAMS")
        self.assertEqual(self.cli.calls, [])

    def test_status_returns_only_safe_version(self):
        self.cli.responses.append(subprocess.CompletedProcess([], 0, "lark-cli version 1.0.88\nprivate=SECRET", ""))
        result = self.call("status")
        self.assertEqual(result["data"], {"available": True, "version": "1.0.88", "host": "com.feishu.clipper"})

    def test_cli_user_identity_and_shell_free_arguments(self):
        self.cli.success({"document": {"document_id": self.source, "title": "标题", "revision_id": 7,
                                        "owner": "PRIVATE", "access_token": "SECRET"}})
        result = self.call("get_document", token=self.source)
        self.assertEqual(result["data"]["document"], {"document_id": self.source, "title": "标题", "revision_id": 7})
        argv, kwargs = self.cli.calls[0]
        self.assertEqual(argv[:4], ["/test/lark-cli", "api", "GET", "/open-apis/docx/v1/documents/" + self.source])
        self.assertEqual(argv[argv.index("--as") + 1], "user")
        self.assertNotIn("--yes", argv)
        self.assertNotIn("shell", kwargs)
        self.assertEqual(kwargs["timeout"], 30)

    def test_legacy_openapi_success_envelope(self):
        self.cli.success({"auth_result": True}, legacy=True)
        self.assertEqual(self.call("check_copy", token=self.source), {"ok": True, "data": {"auth_result": True}})

    def test_paginated_spaces_strip_unknown_and_keep_empty_more(self):
        self.cli.success({"items": [], "has_more": True, "page_token": "opaque/+==", "secret": "SECRET"})
        result = self.call("list_spaces", page_token="first")
        self.assertEqual(result["data"], {"items": [], "has_more": True, "page_token": "opaque/+=="})

    def test_personal_space_and_parent_listing(self):
        self.cli.success({"space": {"name": "我的文档库", "space_id": "123", "owner_id": "private"}})
        self.assertEqual(self.call("get_space", space_id="my_library")["data"]["space"],
                         {"name": "我的文档库", "space_id": "123"})
        self.cli.success({"items": [{"node_token": self.parent, "title": "目录", "owner": "private"}], "has_more": False})
        result = self.call("list_nodes", space_id="123", parent_node_token=self.parent)
        self.assertEqual(result["data"]["items"], [{"node_token": self.parent, "title": "目录"}])
        query = json.loads(self.cli.calls[-1][0][-1])
        self.assertEqual(query["parent_node_token"], self.parent)

    def test_node_type_allowlist(self):
        self.assertEqual(self.call("get_node", token=self.source, obj_type="file")["code"], "INVALID_PARAMS")
        self.cli.success({"node": {"node_token": self.parent, "obj_token": self.source, "obj_type": "docx", "owner": "private"}})
        result = self.call("get_node", token=self.parent)
        self.assertNotIn("owner", result["data"]["node"])

    def test_error_messages_do_not_echo_secrets(self):
        self.cli.failure({"ok": False, "error": {"type": "authentication", "subtype": "token_missing",
                            "message": "access_token=SECRET", "hint": "secret=SECRET"}}, code=3)
        result = self.call("check_copy", token=self.source)
        self.assertEqual(result["code"], "AUTH_REQUIRED")
        self.assertNotIn("SECRET", json.dumps(result))

    def test_missing_scope_uses_static_precise_scope(self):
        self.cli.failure({"code": 99991679, "msg": "SECRET"})
        result = self.call("check_copy", token=self.source)
        self.assertEqual(result["code"], "MISSING_SCOPE")
        self.assertIn("docs:permission.member:auth", result["error"])
        self.assertNotIn("SECRET", json.dumps(result))

    def test_copy_checks_permission_and_uses_actual_root_token(self):
        result = self.copy_success()
        self.assertNotIn("MUST_NOT_LEAK", json.dumps(result))
        argv = self.cli.calls[-1][0]
        body = json.loads(argv[argv.index("--data") + 1])
        self.assertEqual(body, {"name": "原文标题", "type": "docx", "folder_token": "RootFolder123"})
        journal = json.loads((self.directory / "operations.json").read_text())
        self.assertEqual(journal[self.operation]["copied_token"], self.copy)
        self.assertEqual(stat.S_IMODE((self.directory / "operations.json").stat().st_mode), 0o600)

    def test_copy_denied_creates_no_record_or_copy(self):
        self.cli.success({"auth_result": False})
        result = self.call("copy_doc", token=self.source, name="原文标题", operation_id=self.operation)
        self.assertEqual(result["code"], "COPY_FORBIDDEN")
        self.assertEqual(len(self.cli.calls), 1)
        self.assertFalse((self.directory / "operations.json").exists())

    def test_copy_idempotency_survives_host_restart(self):
        first = self.copy_success()
        self.host = host_module.NativeHost("/test/lark-cli", self.directory, self.cli)
        second = self.call("copy_doc", token=self.source, name="原文标题", operation_id=self.operation)
        self.assertEqual(first, second)
        self.assertEqual(len(self.cli.calls), 3)
        self.assertEqual(self.call("copy_doc", token="OtherSource", name="原文标题", operation_id=self.operation)["code"], "OPERATION_CONFLICT")

    def test_copy_pending_saved_before_post_and_uncertain_never_repeats(self):
        self.cli.success({"auth_result": True}).success({"token": "RootFolder123"})
        self.cli.responses.append(subprocess.TimeoutExpired([], 30))
        result = self.call("copy_doc", token=self.source, name="原文标题", operation_id=self.operation)
        self.assertTrue(result["uncertain"])
        self.host = host_module.NativeHost("/test/lark-cli", self.directory, self.cli)
        self.assertEqual(self.call("copy_doc", token=self.source, name="原文标题", operation_id=self.operation)["code"], "COPY_UNCERTAIN")
        self.assertEqual(len(self.cli.calls), 3)

    def test_copy_known_permission_failure_can_retry_same_operation(self):
        self.cli.success({"auth_result": True}).success({"token": "RootFolder123"})
        self.cli.failure({"code": 1061004}, stdout=True)
        self.assertEqual(self.call("copy_doc", token=self.source, name="原文标题", operation_id=self.operation)["code"], "PERMISSION_DENIED")
        self.copy_success()
        self.assertEqual(len(self.cli.calls), 6)

    def test_copy_malformed_success_and_source_token_are_uncertain(self):
        for token in ("../bad", self.source):
            operation = self.operation + token.replace("/", "_").replace(".", "_")
            self.cli.success({"auth_result": True}).success({"token": "RootFolder123"})
            self.cli.success({"file": {"token": token, "name": "原文标题", "type": "docx"}})
            result = self.call("copy_doc", token=self.source, name="原文标题", operation_id=operation)
            self.assertTrue(result["uncertain"])

    def test_move_forbids_original_unknown_and_mismatched_operation(self):
        self.copy_success()
        for token, operation in ((self.source, self.operation), ("UnknownDocx", self.operation), (self.copy, "unknown-operation")):
            result = self.call("move_doc", obj_token=token, space_id="123", operation_id=operation)
            self.assertEqual(result["code"], "MOVE_FORBIDDEN")
        self.assertEqual(len(self.cli.calls), 3)

    def test_move_parent_must_match_space(self):
        self.copy_success()
        self.cli.success({"node": {"space_id": "999", "node_token": self.parent}})
        self.assertEqual(self.move()["code"], "TARGET_MISMATCH")
        self.assertEqual(len(self.cli.calls), 4)

    def test_move_task_id_preserved_and_never_resubmitted(self):
        self.copy_success()
        self.parent_success()
        task = "7037044037068177428-075c9481e6a0007c1df689dfbe5b55a08b6b06f7"
        self.cli.success({"task_id": task})
        first = self.move()
        self.assertEqual(first["data"], {"task_id": task})
        body = json.loads(self.cli.calls[-1][0][-1])
        self.assertEqual(body["obj_token"], self.copy)
        self.assertIs(body["apply"], False)
        self.host = host_module.NativeHost("/test/lark-cli", self.directory, self.cli)
        self.assertTrue(self.move()["data"]["recovering"])
        self.assertEqual(self.host.store.read("operations.json", {})[self.operation]["task_id"], task)
        self.assertEqual(len(self.cli.calls), 5)

    def test_move_timeout_is_uncertain_and_keeps_copy(self):
        self.copy_success()
        self.parent_success()
        self.cli.responses.append(subprocess.TimeoutExpired([], 30))
        result = self.move()
        self.assertTrue(result["ok"])
        self.assertTrue(result["data"]["recovering"])
        self.assertEqual(self.move(), result)
        self.assertEqual(len(self.cli.calls), 5)

    def test_known_move_failure_can_retry_same_copy(self):
        self.copy_success()
        self.parent_success()
        self.cli.failure({"code": 131006}, stdout=True)
        self.assertEqual(self.move()["code"], "PERMISSION_DENIED")
        self.cli.failure({"code": 131005})
        self.parent_success()
        self.cli.success({"wiki_token": "DestinationWiki123"})
        self.assertTrue(self.move()["data"]["recovering"])
        self.cli.success({"node": {"space_id": "123456789", "node_token": "DestinationWiki123",
                                  "obj_token": self.copy, "obj_type": "docx", "parent_node_token": self.parent}})
        self.assertEqual(self.move()["data"], {"wiki_token": "DestinationWiki123"})
        self.assertEqual(len(self.cli.calls), 9)

    def test_task_success_verifies_copy_and_destination(self):
        self.copy_success()
        self.parent_success()
        self.cli.success({"task_id": "task-123"})
        self.move()
        self.cli.success({"task": {"move_result": [{"status": 0, "status_msg": "SECRET",
            "node": {"space_id": "123456789", "node_token": "DestinationWiki123", "obj_token": self.copy,
                     "obj_type": "docx", "parent_node_token": self.parent, "owner": "PRIVATE"}}]}})
        self.cli.success({"node": {"space_id": "123456789", "node_token": "DestinationWiki123", "obj_token": self.copy,
                                  "obj_type": "docx", "parent_node_token": self.parent}})
        result = self.call("get_task", task_id="task-123")
        self.assertTrue(result["ok"], result)
        self.assertNotIn("SECRET", json.dumps(result))
        self.assertNotIn("PRIVATE", json.dumps(result))
        self.assertEqual(self.move()["data"], {"wiki_token": "DestinationWiki123"})

    def test_task_stale_empty_parent_resolves_authoritative_destination(self):
        self.copy_success()
        self.parent_success()
        self.cli.success({"task_id": "task-123"})
        self.move()
        snapshot = {"space_id": "123456789", "node_token": "DestinationWiki123", "obj_token": self.copy,
                    "obj_type": "docx", "parent_node_token": ""}
        self.cli.success({"task": {"move_result": [{"status": 0, "node": snapshot}]}})
        self.cli.success({"node": {**snapshot, "parent_node_token": self.parent}})
        result = self.call("get_task", task_id="task-123")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["data"]["task"]["move_result"][0]["node"]["parent_node_token"], self.parent)
        self.assertEqual(self.cli.calls[-1][0][3], "/open-apis/wiki/v2/spaces/get_node")
        self.assertEqual(json.loads(self.cli.calls[-1][0][-1]), {"token": "DestinationWiki123", "obj_type": "wiki"})
        self.assertEqual(self.move()["data"], {"wiki_token": "DestinationWiki123"})

    def test_task_success_never_ignores_wrong_authoritative_parent_or_type(self):
        self.copy_success()
        self.parent_success()
        self.cli.success({"task_id": "task-123"})
        self.move()
        snapshot = {"space_id": "123456789", "node_token": "DestinationWiki123", "obj_token": self.copy,
                    "obj_type": "docx", "parent_node_token": self.parent}
        for overrides in ({"parent_node_token": "OtherParent"}, {"obj_type": "sheet"}, {"obj_token": self.source}):
            self.cli.success({"task": {"move_result": [{"status": 0, "node": snapshot}]}})
            self.cli.success({"node": {**snapshot, **overrides}})
            result = self.call("get_task", task_id="task-123")
            self.assertEqual(result["code"], "TARGET_MISMATCH")

    def test_task_cannot_claim_wrong_destination_or_source(self):
        self.copy_success()
        self.parent_success()
        self.cli.success({"task_id": "task-123"})
        self.move()
        self.cli.success({"task": {"move_result": [{"status": 0, "node": {"space_id": "123456789",
            "node_token": "DestinationWiki123", "obj_token": self.source, "parent_node_token": self.parent}}]}})
        self.assertEqual(self.call("get_task", task_id="task-123")["code"], "TARGET_MISMATCH")

    def test_failed_task_allows_user_resume_to_retry_same_copy(self):
        self.copy_success()
        self.parent_success()
        self.cli.success({"task_id": "task-123"})
        self.move()
        self.cli.success({"task": {"move_result": [{"status": -1, "status_msg": "private debug SECRET"}]}})
        result = self.call("get_task", task_id="task-123")
        self.assertEqual(result["data"]["task"]["move_result"][0]["status"], -1)
        self.assertNotIn("SECRET", json.dumps(result))
        self.cli.failure({"code": 131005})
        self.parent_success()
        self.cli.success({"task_id": "task-456"})
        self.assertEqual(self.move()["data"], {"task_id": "task-456"})

    def test_unknown_task_never_queries_cli(self):
        self.assertEqual(self.call("get_task", task_id="123-hash")["code"], "TASK_FORBIDDEN")
        self.assertEqual(self.cli.calls, [])

    def test_login_device_code_stays_in_private_local_file(self):
        url = "https://accounts.feishu.cn/oauth/authorize?user_code=USERCODE"
        self.cli.direct({"verification_url": url, "device_code": "PRIVATE_DEVICE_CODE", "expires_in": 240,
                         "access_token": "TOKEN_MUST_NOT_ESCAPE"})
        result = self.call("authorize_start")
        self.assertEqual(result, {"ok": True, "data": {"verification_url": url}})
        auth_path = self.directory / "authorization.json"
        self.assertEqual(stat.S_IMODE(auth_path.stat().st_mode), 0o600)
        self.assertFalse((self.directory / "operations.json").exists())
        args = self.cli.calls[0][0]
        self.assertEqual(args[args.index("--scope") + 1], " ".join(host_module.SCOPES))
        for legacy_scope in ("docs:document:copy", "docs:permission.member:auth", "drive:drive.metadata:readonly"):
            self.assertNotIn(legacy_scope, host_module.SCOPES)
        for scope in ("docx:document:create", "docx:document:write_only", "docs:document.media:upload", "wiki:node:move"):
            self.assertIn(scope, host_module.SCOPES)
        self.cli.direct({"event": "authorization_complete", "user_open_id": "PRIVATE_USER", "scope": "private", "missing": []})
        self.assertEqual(self.call("authorize_finish"), {"ok": True, "data": {"authorized": True}})
        self.assertEqual(json.loads(auth_path.read_text()), {})
        self.assertEqual(self.cli.calls[-1][0][-3:], ["--device-code", "PRIVATE_DEVICE_CODE", "--json"])

    def test_login_url_validation_and_expiry(self):
        for url in ("https://evil.test/oauth", "http://accounts.feishu.cn/oauth", "https://accounts.feishu.cn/oauth?access_token=SECRET"):
            self.cli.direct({"verification_url": url, "device_code": "SECRET", "expires_in": 240})
            result = self.call("authorize_start")
            self.assertEqual(result["code"], "AUTH_RESPONSE_INVALID")
        self.assertEqual(self.call("authorize_finish")["code"], "AUTH_EXPIRED")

    def test_state_symlink_corruption_and_lock_prevent_writes(self):
        (self.directory / "operations.json").write_text("not json")
        self.assertEqual(self.call("copy_doc", token=self.source, name="原文标题", operation_id=self.operation)["code"], "STATE_ERROR")
        with self.host.store.locked():
            self.assertEqual(self.call("status")["code"], "BUSY")
        link = Path(self.temp.name).resolve() / "link"
        link.symlink_to(self.directory, target_is_directory=True)
        with self.assertRaises(host_module.HostError):
            host_module.StateStore(link)

    def test_native_protocol_frames_and_one_megabyte_limit(self):
        def frame(message):
            encoded = json.dumps(message).encode()
            return struct.pack("=I", len(encoded)) + encoded
        self.cli.responses.append(subprocess.CompletedProcess([], 0, "lark-cli version 1.0.88", ""))
        data = io.BytesIO(frame({"action": "status", "params": {}}) + frame({"action": "delete"}))
        output = io.BytesIO()
        host_module.serve(self.host, data, output)
        output.seek(0)
        first_size = struct.unpack("=I", output.read(4))[0]
        self.assertTrue(json.loads(output.read(first_size))["ok"])
        second_size = struct.unpack("=I", output.read(4))[0]
        self.assertEqual(json.loads(output.read(second_size))["code"], "UNKNOWN_ACTION")
        output = io.BytesIO()
        host_module.serve(self.host, io.BytesIO(struct.pack("=I", host_module.MAX_MESSAGE + 1)), output)
        output.seek(4)
        self.assertEqual(json.load(output)["code"], "MESSAGE_TOO_LARGE")

    def test_native_protocol_handles_invalid_and_truncated_json(self):
        output = io.BytesIO()
        host_module.serve(self.host, io.BytesIO(struct.pack("=I", 3) + b"xyz"), output)
        output.seek(4)
        self.assertEqual(json.load(output)["code"], "INVALID_REQUEST")
        output = io.BytesIO()
        host_module.serve(self.host, io.BytesIO(struct.pack("=I", 10) + b"x"), output)
        self.assertEqual(output.getvalue(), b"")

    def test_process_timeout_terminates_cli_process_group(self):
        # A real disposable subprocess exercises the lifecycle used by npm wrappers.
        with self.assertRaises(subprocess.TimeoutExpired):
            host_module.run_cli_process([sys.executable, "-c", "import time; time.sleep(5)"], timeout=0.03)

    def test_no_yes_on_cli_confirmation_required(self):
        self.cli.success({"auth_result": True}).success({"token": "RootFolder123"})
        self.cli.failure({"ok": False, "error": {"type": "confirmation_required", "hint": "SECRET"}}, code=10)
        result = self.call("copy_doc", token=self.source, name="原文标题", operation_id=self.operation)
        self.assertEqual(result["code"], "CONFIRMATION_REQUIRED")
        self.assertNotIn("SECRET", json.dumps(result))
        self.assertTrue(all("--yes" not in call[0] for call in self.cli.calls))


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="feishu-installer-test-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()

    def install(self, extension="a" * 32, **kwargs):
        return installer.install(extension, home=self.home, platform="darwin", python=sys.executable,
                                 lark="/usr/bin/true", node="/usr/bin/true", **kwargs)

    def test_install_manifest_origin_paths_permissions_and_idempotency(self):
        result = self.install()
        self.assertEqual(self.install(), result)
        manifest = json.loads(Path(result["manifest"]).read_text())
        self.assertEqual(manifest["allowed_origins"], ["chrome-extension://" + "a" * 32 + "/"])
        self.assertEqual(manifest["name"], "com.feishu.clipper")
        self.assertEqual(manifest["path"], result["launcher"])
        launcher = Path(result["launcher"]).read_text()
        self.assertIn("env['PATH']", launcher)
        self.assertIn(str(Path(sys.executable).absolute()), launcher)
        self.assertNotIn("shell=True", launcher)
        self.assertEqual(stat.S_IMODE(Path(result["launcher"]).stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(Path(result["state_dir"]).stat().st_mode), 0o700)

    def test_conflicting_installation_requires_explicit_force_and_preserves_state(self):
        first = self.install()
        manifest = Path(first["manifest"]).read_text()
        state = Path(first["state_dir"]) / "operations.json"
        state.write_text('{"kept": true}')
        with self.assertRaises(ValueError):
            self.install("b" * 32)
        self.assertEqual(Path(first["manifest"]).read_text(), manifest)
        self.install("b" * 32, force=True)
        self.assertEqual(state.read_text(), '{"kept": true}')

    def test_invalid_id_and_symlink_destination_are_rejected(self):
        for extension in ("x" * 32, "a" * 31, "a/" * 16):
            with self.assertRaises(ValueError):
                self.install(extension)
        support = self.home / "Library"
        real = self.home / "real"
        real.mkdir()
        support.symlink_to(real, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.install()

    def test_linux_browser_locations(self):
        for browser, segment in (("chrome", "google-chrome"), ("edge", "microsoft-edge"), ("chromium", "chromium")):
            app, manifest = installer.installation_paths(self.home, "linux", browser)
            self.assertEqual(manifest, self.home / ".config" / segment / "NativeMessagingHosts")
            self.assertEqual(app, self.home / ".local/share/feishu-clipper/native-host")

    def test_dia_registers_separately_and_reuses_chrome_connector_state(self):
        chrome = self.install()
        state = Path(chrome["state_dir"]) / "operations.json"
        state.write_text('{"kept": true}')
        dia = self.install(browser="dia")
        self.assertEqual(Path(dia["manifest"]), self.home / "Library/Application Support/Dia/NativeMessagingHosts/com.feishu.clipper.json")
        self.assertEqual(dia["launcher"], chrome["launcher"])
        self.assertEqual(dia["state_dir"], chrome["state_dir"])
        self.assertEqual(state.read_text(), '{"kept": true}')
        self.assertEqual(Path(dia["manifest"]).read_text(), Path(chrome["manifest"]).read_text())
        self.assertEqual(self.install(browser="dia"), dia)
        with self.assertRaisesRegex(ValueError, "仅支持 macOS"):
            installer.installation_paths(self.home, "linux", "dia")

    def test_generated_launcher_runs_protocol_and_checks_origin(self):
        result = self.install()
        origin = "chrome-extension://" + "a" * 32 + "/"
        raw = json.dumps({"action": "status", "params": {}}).encode()
        message = struct.pack("=I", len(raw)) + raw
        command = [str(Path(sys.executable).absolute()), result["launcher"]]
        completed = subprocess.run(command + [origin], input=message, capture_output=True, timeout=5)
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(completed.stderr, b"")
        size = struct.unpack("=I", completed.stdout[:4])[0]
        response = json.loads(completed.stdout[4:4 + size])
        self.assertTrue(response["ok"], response)
        denied = subprocess.run(command + ["chrome-extension://" + "b" * 32 + "/"],
                                input=message, capture_output=True, timeout=5)
        self.assertEqual(denied.returncode, 1)
        self.assertEqual(denied.stdout, b"")


if __name__ == "__main__":
    unittest.main()
