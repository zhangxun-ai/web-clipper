"""Durable known-document move recovery; fake CLI only, no Feishu writes."""

import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from feishu_native_host_test import FakeCLI, host_module


class MoveRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="feishu-move-recovery-test-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name).resolve() / "state"
        self.cli = FakeCLI()
        self.host = host_module.NativeHost("/test/lark-cli", self.directory, self.cli)
        self.now = 1000.0
        self.clock = patch("time.time", side_effect=lambda: self.now)
        self.clock.start()
        self.addCleanup(self.clock.stop)
        self.op, self.copy, self.parent = "move-operation-123", "CreatedDocx", "TargetParent"
        self.params = {"operation_id": self.op, "obj_token": self.copy, "space_id": "123", "parent_node_token": self.parent}
        self.write({"mode": "content", "source": "SourceDocx", "copied_token": self.copy,
                    "content_verified": True, "stage": "content_ready", "name": "PRIVATE_BODY"})

    def write(self, record):
        self.host.store.write("operations.json", {self.op: record})

    def record(self):
        return self.host.store.read("operations.json", {})[self.op]

    def move(self, **overrides):
        result = self.host.handle({"action": "move_doc", "params": {**self.params, **overrides}})
        self.assertNotIn("PRIVATE", json.dumps(result))
        return result

    def advance(self):
        self.now = max(self.now + 1, self.record()["move_recovery"]["next_run_at"])

    def restart(self):
        self.host = host_module.NativeHost("/test/lark-cli", self.directory, self.cli)

    def parent_ok(self):
        self.cli.success({"node": {"space_id": "123", "node_token": self.parent}})

    def located(self, **overrides):
        self.cli.success({"node": {"space_id": "123", "node_token": "SavedWiki", "node_type": "origin",
                                  "obj_type": "docx", "obj_token": self.copy,
                                  "parent_node_token": self.parent, **overrides}})

    def absent(self):
        self.cli.failure({"code": 131005, "msg": "PRIVATE"})

    def network(self):
        self.cli.failure({"error": {"type": "network", "message": "PRIVATE"}})

    def posts(self):
        return [argv for argv, _ in self.cli.calls if argv[2] == "POST"]

    def lose_response(self):
        self.parent_ok()
        self.network()
        result = self.move()
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["data"]["recovering"])
        return result

    def test_committed_move_lost_response_recovers_exact_document_after_restart(self):
        first = self.lose_response()
        before = len(self.cli.calls)
        self.restart()
        self.assertEqual(self.move(), first)
        self.assertEqual(len(self.cli.calls), before)
        self.advance()
        self.located()
        self.assertEqual(self.move(), {"ok": True, "data": {"wiki_token": "SavedWiki"}})
        self.assertEqual(len(self.posts()), 1)
        self.assertEqual(self.record()["stage"], "moved")
        self.assertNotIn("last_error", self.record())
        self.assertTrue(self.record()["error_history"])
        query = json.loads(self.cli.calls[-1][0][-1])
        self.assertEqual(query, {"token": self.copy, "obj_type": "docx"})

    def test_unsubmitted_move_replays_only_same_document_then_verifies_result(self):
        self.lose_response()
        self.advance()
        self.absent()
        self.parent_ok()
        self.cli.success({"wiki_token": "SavedWiki"})
        result = self.move()
        self.assertTrue(result["data"]["recovering"])
        self.assertEqual(self.record()["stage"], "moving")
        self.located()
        self.assertEqual(self.move()["data"], {"wiki_token": "SavedWiki"})
        self.assertEqual(len(self.posts()), 2)
        bodies = [json.loads(call[-1]) for call in self.posts()]
        self.assertEqual(bodies[0], bodies[1])
        self.assertEqual(bodies[0], {"obj_type": "docx", "obj_token": self.copy,
                                    "parent_wiki_token": self.parent, "apply": False})
        self.assertTrue(all("/documents" not in call[3] for call in self.posts()))

    def test_read_network_failure_only_defers_and_does_not_extend_deadline(self):
        self.lose_response()
        deadline = self.record()["move_recovery"]["deadline"]
        self.advance()
        self.network()
        result = self.move()
        self.assertTrue(result["data"]["recovering"])
        self.assertEqual(len(self.posts()), 1)
        self.assertEqual(self.record()["move_recovery"]["deadline"], deadline)
        self.assertEqual(self.record()["move_recovery"]["next_run_at"], self.now + 2)
        self.assertEqual(self.record()["last_error"]["code"], "CLI_NETWORK")

    def test_no_wrong_parent_type_shortcut_or_source_can_be_claimed(self):
        self.lose_response()
        for changes in ({"parent_node_token": "Other"}, {"space_id": "999"}, {"obj_type": "sheet"},
                        {"node_type": "shortcut"}, {"obj_token": "SourceDocx"}):
            with self.subTest(changes=changes):
                self.advance()
                self.located(**changes)
                self.assertEqual(self.move()["code"], "TARGET_MISMATCH")
        self.assertEqual(len(self.posts()), 1)
        self.assertNotEqual(self.record()["stage"], "moved")

    def test_unknown_or_changed_bound_inputs_never_issue_requests(self):
        self.lose_response()
        before = len(self.cli.calls)
        for params, code in (({"obj_token": "SourceDocx"}, "MOVE_FORBIDDEN"),
                             ({"obj_token": "Other"}, "MOVE_FORBIDDEN"),
                             ({"parent_node_token": "Other"}, "TARGET_CONFLICT"),
                             ({"space_id": "999"}, "TARGET_CONFLICT")):
            self.assertEqual(self.move(**params)["code"], code)
        self.assertEqual(len(self.cli.calls), before)

    def test_rate_limit_delay_survives_restart(self):
        self.parent_ok()
        self.cli.failure({"error": {"code": 99991400, "retry_after_seconds": 120, "message": "PRIVATE"}})
        self.assertEqual(self.move()["data"]["deferred_until"], 1120000)
        self.restart()
        self.now = 1119
        before = len(self.cli.calls)
        self.assertEqual(self.move()["data"]["deferred_until"], 1120000)
        self.assertEqual(len(self.cli.calls), before)
        self.advance()
        self.absent()
        self.parent_ok()
        self.cli.success({"task_id": "Task123"})
        self.assertEqual(self.move()["data"], {"task_id": "Task123"})
        self.assertEqual(len(self.posts()), 2)

    def test_post_limit_only_polls_until_deadline_and_does_not_reset(self):
        self.lose_response()
        deadline = self.record()["move_recovery"]["deadline"]
        for _ in range(4):
            self.advance()
            self.absent()
            self.parent_ok()
            self.network()
            self.assertTrue(self.move()["data"]["recovering"])
        self.advance()
        self.absent()
        self.assertTrue(self.move()["data"]["recovering"])
        self.assertEqual(len(self.posts()), 5)
        self.now = deadline
        before = len(self.cli.calls)
        self.restart()
        self.assertEqual(self.move()["code"], "MOVE_UNCERTAIN")
        self.assertEqual(len(self.cli.calls), before)
        self.assertEqual(self.record()["move_recovery"]["deadline"], deadline)
        summary = self.host.handle({"action": "get_operation", "params": {"operation_id": self.op}})["data"]
        self.assertFalse(summary["move_recovery"]["recoverable"])
        self.assertEqual(summary["move_recovery"]["deadline"], int(deadline * 1000))

    def test_legacy_pending_and_uncertain_records_initialize_once_and_recover(self):
        for stage in ("move_pending", "move_uncertain"):
            with self.subTest(stage=stage):
                record = self.record()
                record.pop("move_recovery", None)
                record.update({"stage": stage, "target": {"space_id": "123", "parent_node_token": self.parent},
                               "error_code": "CLI_NETWORK"})
                self.write(record)
                before = len(self.posts())
                self.located()
                self.assertEqual(self.move()["data"], {"wiki_token": "SavedWiki"})
                self.assertEqual(len(self.posts()), before)
                self.assertEqual(self.record()["move_recovery"]["post_attempts"], 1)

    def test_131007_reconciles_once_but_never_reposts(self):
        self.parent_ok()
        self.cli.failure({"code": 131007, "msg": "PRIVATE"})
        self.assertTrue(self.move()["data"]["recovering"])
        self.advance()
        self.absent()
        self.assertEqual(self.move()["code"], "131007")
        self.assertEqual(len(self.posts()), 1)
        self.restart()
        self.located()
        self.assertEqual(self.move()["data"], {"wiki_token": "SavedWiki"})
        self.assertEqual(len(self.posts()), 1)

    def test_131007_can_recover_a_committed_move_by_reading(self):
        self.parent_ok()
        self.cli.failure({"code": 131007})
        self.move()
        self.advance()
        self.located()
        self.assertEqual(self.move()["data"], {"wiki_token": "SavedWiki"})
        self.assertEqual(len(self.posts()), 1)

    def test_task_is_polled_by_move_doc_and_processing_is_durable(self):
        self.parent_ok()
        self.cli.success({"task_id": "Task123"})
        self.assertEqual(self.move()["data"], {"task_id": "Task123"})
        self.advance()
        self.absent()
        self.cli.success({"task": {"move_result": [{"status": 1}]}})
        self.assertTrue(self.move()["data"]["recovering"])
        self.restart()
        self.advance()
        self.located()
        self.assertEqual(self.move()["data"], {"wiki_token": "SavedWiki"})
        self.assertEqual(len(self.posts()), 1)

    def test_task_failure_preserves_document_and_does_not_repost(self):
        self.parent_ok()
        self.cli.success({"task_id": "Task123"})
        self.move()
        self.advance()
        self.absent()
        self.cli.success({"task": {"move_result": [{"status": -1, "status_msg": "PRIVATE"}]}})
        self.assertEqual(self.move()["code"], "MOVE_FAILED")
        self.assertEqual(self.record()["copied_token"], self.copy)
        self.assertEqual(self.record()["stage"], "move_failed")
        self.assertEqual(len(self.posts()), 1)

    def test_permission_error_is_actionable_and_never_becomes_unknown_retry(self):
        self.lose_response()
        self.advance()
        self.cli.failure({"code": 131006, "msg": "PRIVATE"})
        self.assertEqual(self.move()["code"], "PERMISSION_DENIED")
        summary = self.host.handle({"action": "get_operation", "params": {"operation_id": self.op}})["data"]
        self.assertFalse(summary["move_recovery"]["recoverable"])
        self.assertEqual(len(self.posts()), 1)

    def test_parent_preflight_network_failure_never_counts_as_post(self):
        self.network()
        self.assertTrue(self.move()["data"]["recovering"])
        self.assertEqual(self.record()["move_recovery"]["post_attempts"], 0)
        self.assertEqual(self.posts(), [])

    def test_slow_parent_preflight_cannot_send_post_after_deadline(self):
        self.parent_ok()
        def slow_runner(*args, **kwargs):
            result = self.cli(*args, **kwargs)
            self.now += host_module.MOVE_RECOVERY_SECONDS
            return result
        self.host.runner = slow_runner
        self.assertEqual(self.move()["code"], "MOVE_UNCERTAIN")
        self.assertEqual(self.record()["move_recovery"]["post_attempts"], 0)
        self.assertEqual(self.posts(), [])

    def test_malformed_task_response_is_read_only_recoverable(self):
        self.parent_ok()
        self.cli.success({"task_id": "Task123"})
        self.move()
        for malformed in (None, [], "PRIVATE"):
            self.advance()
            self.absent()
            self.cli.success({"task": malformed})
            self.assertTrue(self.move()["data"]["recovering"])
        self.assertEqual(len(self.posts()), 1)

    def test_task_success_confirms_live_parent_before_completion(self):
        self.parent_ok()
        self.cli.success({"task_id": "Task123"})
        self.move()
        self.advance()
        self.absent()
        self.cli.success({"task": {"move_result": [{"status": 0, "node": {
            "space_id": "123", "node_token": "SavedWiki", "obj_token": self.copy,
            "obj_type": "docx", "parent_node_token": ""}}]}})
        self.located()
        self.assertEqual(self.move()["data"], {"wiki_token": "SavedWiki"})
        self.assertEqual(self.record()["stage"], "moved")
        self.assertEqual(len(self.posts()), 1)

    def test_recovery_summary_excludes_private_error_and_body_fields(self):
        self.lose_response()
        summary = self.host.handle({"action": "get_operation", "params": {"operation_id": self.op}})["data"]
        self.assertNotIn("PRIVATE", json.dumps(summary))
        self.assertTrue(summary["move_recovery"]["recoverable"])
        self.assertEqual(summary["move_recovery"]["deadline"], 1900000)
        self.assertEqual(summary["move_recovery"]["deferred_until"], 1001000)


if __name__ == "__main__":
    unittest.main()
