"""Decoded image dimensions, durable media binding batches and web callouts."""
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
import zlib

spec = importlib.util.spec_from_file_location("image_layout_fixtures", Path(__file__).with_name("feishu_content_import_test.py"))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)


def png(width, height):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress((b"\0" + b"\xff" * width) * height)) + chunk(b"IEND", b""))


def snapshot(count):
    ids = ["Image" + str(index) for index in range(count)]
    return {"title": "图片完整性", "source_url": "https://scys.com/articleDetail/xq_topic/image-layout",
            "blocks": [{"block_id": "WebRoot", "block_type": 1, "children": ids}] + [
                {"block_id": item, "block_type": 27, "image": {"token": item}} for item in ids],
            "images": [{"block_id": item, "url": "https://example.com/" + item + ".png"} for item in ids]}


class MultiImageCLI(fixtures.ImportCLI):
    def __call__(self, argv, **kwargs):
        if argv[1:4] == ["api", "POST", "/open-apis/drive/v1/medias/upload_all"]:
            self.calls.append(argv)
            self.assert_user(argv)
            body = json.loads(argv[argv.index("--data") + 1])
            assert body["parent_node"] in self.target
            assert json.loads(body["extra"])["drive_route_token"] == "Created"
            data = {"file_token": "Uploaded" + body["parent_node"]}
            return subprocess.CompletedProcess(argv, 0, json.dumps({"ok": True, "data": data}), "")
        return super().__call__(argv, **kwargs)


class ImageLayoutTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="feishu-image-layout-test-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name).resolve() / "state"
        self.cli = MultiImageCLI()
        self.host = fixtures.native.NativeHost("/mock/lark-cli", self.directory, self.cli)
        self.operation = "image-layout-operation"

    def call(self, action, **params):
        return self.host.handle({"action": action, "params": {"operation_id": self.operation, **params}})

    def prepare(self, value):
        result = self.call("prepare_web_content", source_url=value["source_url"], snapshot=value)
        self.assertTrue(result["ok"], result)

    def stage(self, index, width=1280, height=661, **overrides):
        data = png(width, height)
        params = {"block_id": "Image" + str(index), "offset": 0, "total_size": len(data), "mime_type": "image/png",
                  "data_base64": base64.b64encode(data).decode(), "pixel_width": width, "pixel_height": height}
        params.update(overrides)
        return self.call("stage_image", **params)

    def legacy_stage(self, index, data, offset=0, end=None):
        return self.call("stage_image", block_id="Image" + str(index), offset=offset, total_size=len(data), mime_type="image/png",
                         data_base64=base64.b64encode(data[offset:end]).decode())

    def step(self):
        count = len(self.cli.calls)
        result = self.call("import_step")
        self.assertLessEqual(len(self.cli.calls) - count, 1, "each step performs at most one remote request")
        return result

    def through_uploads(self):
        for _ in range(100):
            _, _, plan = self.host.content.read(self.operation)
            if all(image.get("uploaded_token") for image in plan["images"]):
                return
            result = self.step()
            self.assertTrue(result["ok"], result)
        self.fail("Uploads did not finish")

    def finish(self):
        for _ in range(100):
            result = self.step()
            self.assertTrue(result["ok"], result)
            if result["data"]["complete"]:
                return result
        self.fail("Import did not finish")

    def image_patches(self):
        return [argv for argv in self.cli.calls if argv[3].endswith("/blocks/batch_update")
                and "replace_image" in argv[argv.index("--data") + 1]]

    def test_17_lazy_images_get_decoded_dimensions_and_18_images_bind_in_one_request(self):
        value = snapshot(18)
        value["blocks"][1]["image"].update({"width": 578, "height": 492})
        value["images"][0].update({"width": 578, "height": 492})
        self.prepare(value)
        self.assertTrue(self.stage(0, 578, 492)["ok"])
        for index in range(1, 18):
            self.assertTrue(self.stage(index)["ok"])
        self.finish()
        self.assertEqual(len([argv for argv in self.cli.calls if argv[3].endswith("/medias/upload_all")]), 18)
        patches = self.image_patches()
        self.assertEqual(len(patches), 1)
        self.assertEqual(len(json.loads(patches[0][patches[0].index("--data") + 1])["requests"]), 18)
        self.assertEqual((self.cli.target["NewImage0"]["image"]["width"], self.cli.target["NewImage0"]["image"]["height"]), (578, 492))
        for index in range(1, 18):
            actual = self.cli.target["NewImage" + str(index)]["image"]
            self.assertEqual((actual["width"], actual["height"]), (720, 372))
        _, _, plan = self.host.content.read(self.operation)
        self.assertEqual((plan["images"][1]["pixel_width"], plan["images"][1]["pixel_height"]), (1280, 661))

    def test_display_width_preserves_smaller_intent_and_never_upscales(self):
        value = snapshot(2)
        for bad in (0, -1, float("nan"), float("inf"), True, "320"):
            invalid = copy.deepcopy(value)
            invalid["images"][0]["display_width"] = bad
            self.assertEqual(self.call("prepare_web_content", source_url=invalid["source_url"], snapshot=invalid)["code"], "INVALID_PARAMS")
        value["images"][0]["display_width"] = 320
        value["images"][1]["display_width"] = 720
        self.prepare(value)
        self.assertTrue(self.stage(0, 1280, 640)["ok"])
        self.assertTrue(self.stage(1, 200, 100)["ok"])
        _, _, plan = self.host.content.read(self.operation)
        self.assertEqual([(image["width"], image["height"]) for image in plan["images"]], [(320, 160), (200, 100)])

    def test_pixel_metadata_is_required_validated_and_conflicts_do_not_modify_staged_bytes(self):
        self.prepare(snapshot(1))
        for key in ("pixel_width", "pixel_height"):
            for value in (0, -1, 100001, 1.5, True, "1280", None):
                with self.subTest(key=key, value=value):
                    result = self.stage(0, **{key: value})
                    self.assertEqual(result["code"], "INVALID_PARAMS")
        data = png(1280, 661)
        first = dict(block_id="Image0", offset=0, total_size=len(data), mime_type="image/png",
                     data_base64=base64.b64encode(data[:24]).decode(), pixel_width=1280, pixel_height=661)
        self.assertTrue(self.call("stage_image", **first)["ok"])
        path = self.host.content.image_path(self.operation, "Image0")
        original = path.read_bytes()
        self.assertEqual(self.call("stage_image", **{**first, "pixel_height": 662})["code"], "IMAGE_CONFLICT")
        missing = dict(first); missing.pop("pixel_width")
        self.assertEqual(self.call("stage_image", **missing)["code"], "INVALID_PARAMS")
        self.assertEqual(path.read_bytes(), original)
        self.assertTrue(self.stage(0)["ok"], "an identical complete replay must remain recoverable")

    def test_legacy_worker_chunks_recover_actual_pixels_after_host_restart(self):
        self.prepare(snapshot(1))
        data = png(1280, 661)
        first = self.legacy_stage(0, data, end=24)
        self.assertTrue(first["ok"], first)
        self.assertFalse(first["data"]["complete"])
        _, _, plan = self.host.content.read(self.operation)
        self.assertNotIn("pixel_width", plan["images"][0])
        self.host = fixtures.native.NativeHost("/mock/lark-cli", self.directory, self.cli)
        result = self.legacy_stage(0, data, offset=24)
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["data"]["complete"])
        _, _, plan = self.host.content.read(self.operation)
        image = plan["images"][0]
        self.assertEqual((image["pixel_width"], image["pixel_height"], image["width"], image["height"]), (1280, 661, 720, 372))
        self.assertEqual(image["sha256"], hashlib.sha256(data).hexdigest())
        self.assertEqual(self.host.content.image_path(self.operation, "Image0").read_bytes(), data)
        self.finish()

    def test_new_and_legacy_worker_chunks_can_resume_each_other_without_losing_metadata(self):
        self.prepare(snapshot(2))
        data = png(1280, 661)
        self.assertTrue(self.stage(0, data_base64=base64.b64encode(data[:24]).decode())["ok"])
        self.assertTrue(self.legacy_stage(0, data, offset=24)["ok"])
        self.assertTrue(self.legacy_stage(1, data, end=24)["ok"])
        self.assertTrue(self.stage(1)["ok"])
        _, _, plan = self.host.content.read(self.operation)
        self.assertEqual([(image["pixel_width"], image["pixel_height"]) for image in plan["images"]], [(1280, 661)] * 2)
        self.assertEqual(self.stage(1, pixel_height=662)["code"], "IMAGE_CONFLICT")
        self.finish()

    def test_legacy_worker_unrecognized_dimensions_never_mark_the_image_complete(self):
        self.prepare(snapshot(1))
        data = b"\x89PNG\r\n\x1a\n" + b"unrecognized legacy image header"
        result = self.legacy_stage(0, data)
        self.assertEqual(result["code"], "IMAGE_DIMENSIONS_REQUIRED")
        _, _, plan = self.host.content.read(self.operation)
        self.assertFalse(plan["images"][0]["staged"])
        self.assertEqual(self.step()["code"], "IMAGES_NOT_READY")
        self.assertEqual(self.cli.calls, [])

    def test_legacy_replay_keeps_bound_and_uncertain_layouts_and_checks_existing_hash(self):
        self.prepare(snapshot(2))
        data = png(1280, 661)
        for index in range(2):
            self.assertTrue(self.stage(index)["ok"])
        journal, _, plan = self.host.content.read(self.operation)
        plan["images"][0]["bound"] = True
        plan["images"][1]["bind_client_token"] = "11111111-1111-4111-8111-111111111111"
        for image in plan["images"]:
            image.update({"width": 100, "height": 100})
            image.pop("pixel_width"); image.pop("pixel_height")
        self.host.content.save(self.operation, journal, plan)
        for index in range(2):
            self.assertTrue(self.legacy_stage(index, data)["ok"])
        _, _, plan = self.host.content.read(self.operation)
        self.assertEqual([(image["width"], image["height"]) for image in plan["images"]], [(100, 100)] * 2)
        path = self.host.content.image_path(self.operation, "Image0")
        changed = bytearray(data); changed[30] ^= 1
        path.write_bytes(changed)
        # Replaying a later identical chunk must not bless changed earlier bytes.
        self.assertEqual(self.legacy_stage(0, data, offset=40)["code"], "IMAGE_CONFLICT")

    def test_binding_batches_limit_twenty_and_replay_the_exact_request_after_response_loss(self):
        self.prepare(snapshot(21))
        for index in range(21):
            self.assertTrue(self.stage(index, 12, 8)["ok"])
        self.through_uploads()
        _, record, plan = self.host.content.read(self.operation)
        completed_before_binding = self.host.content.result(record, plan)["progress"]["completed"]
        upload_count = len(self.cli.calls)
        self.cli.failure = ("after", subprocess.TimeoutExpired([], 30))
        failed = self.step()
        self.assertTrue(failed["retryable"])
        request = self.cli.calls[-1]
        self.assertEqual(len(json.loads(request[request.index("--data") + 1])["requests"]), 20)
        self.host = fixtures.native.NativeHost("/mock/lark-cli", self.directory, self.cli)
        resumed = self.step()
        self.assertTrue(resumed["ok"])
        self.assertEqual(resumed["data"]["progress"]["completed"], completed_before_binding + 20)
        self.assertEqual(self.cli.calls[-1], request)
        result = self.step()
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["progress"]["completed"], completed_before_binding + 21)
        self.assertEqual(len(json.loads(self.cli.calls[-1][self.cli.calls[-1].index("--data") + 1])["requests"]), 1)
        self.assertTrue(all(not argv[3].endswith("/medias/upload_all") for argv in self.cli.calls[upload_count:]))
        self.finish()
        _, _, plan = self.host.content.read(self.operation)
        self.assertTrue(all(image["bound"] for image in plan["images"]))

    def test_legacy_partial_binding_reuses_uuid_and_does_not_modify_completed_image(self):
        self.prepare(snapshot(3))
        for index in range(3):
            self.assertTrue(self.stage(index, 20, 10)["ok"])
        self.through_uploads()
        journal, record, plan = self.host.content.read(self.operation)
        first, pending, _ = plan["images"]
        first.update({"bound": True, "width": 100, "height": 100})
        first.pop("pixel_width"); first.pop("pixel_height")
        self.cli.target["NewImage0"]["image"].update({"token": first["uploaded_token"], "width": 100, "height": 100})
        pending.update({"bind_client_token": "11111111-1111-4111-8111-111111111111", "width": 40, "height": 20})
        pending.pop("pixel_width"); pending.pop("pixel_height")
        self.host.content.save(self.operation, journal, plan)
        count = len(self.cli.calls)
        self.assertTrue(self.step()["ok"])
        request = self.cli.calls[-1]
        self.assertEqual(json.loads(request[request.index("--params") + 1])["client_token"], pending["bind_client_token"])
        body = json.loads(request[request.index("--data") + 1])
        self.assertEqual([(item["block_id"], item["replace_image"]["width"]) for item in body["requests"]], [("NewImage1", 40)])
        self.finish()
        self.assertEqual(self.cli.target["NewImage0"]["image"]["width"], 100)
        self.assertTrue(all(not argv[3].endswith("/medias/upload_all") for argv in self.cli.calls[count:]))

    def test_legacy_staged_png_dimensions_are_recovered_before_creation(self):
        self.prepare(snapshot(1))
        self.assertTrue(self.stage(0)["ok"])
        journal, _, plan = self.host.content.read(self.operation)
        for key in ("width", "height", "pixel_width", "pixel_height"):
            plan["images"][0].pop(key)
        self.host.content.save(self.operation, journal, plan)
        self.finish()
        self.assertEqual(self.cli.target["NewImage0"]["image"]["width"], 720)
        self.assertEqual(self.cli.target["NewImage0"]["image"]["height"], 372)

    def test_legacy_header_reader_handles_supported_formats_and_exif_orientation(self):
        def riff(kind, payload):
            return b"RIFF" + struct.pack("<I", len(payload) + 16) + b"WEBP" + kind + struct.pack("<I", len(payload)) + payload
        tiff = (b"II\x2a\0" + struct.pack("<I", 8) + struct.pack("<H", 1)
                + struct.pack("<HHI", 274, 3, 1) + struct.pack("<H", 6) + b"\0\0" + struct.pack("<I", 0))
        exif = b"Exif\0\0" + tiff
        frame = b"\x08" + struct.pack(">HH", 8, 12) + b"\x01\x01\x11\x00"
        jpeg = b"\xff\xd8\xff\xc0" + struct.pack(">H", len(frame) + 2) + frame
        samples = {
            "png": (png(12, 8), (12, 8)),
            "gif": (b"GIF89a" + struct.pack("<HH", 12, 8) + b"\0" * 10, (12, 8)),
            "bmp": (b"BM" + b"\0" * 12 + struct.pack("<Iii", 40, 12, -8) + b"\0" * 6, (12, 8)),
            "webp_extended": (riff(b"VP8X", b"\0" * 4 + (11).to_bytes(3, "little") + (7).to_bytes(3, "little")), (12, 8)),
            "webp_lossless": (riff(b"VP8L", b"\x2f" + struct.pack("<I", 11 | (7 << 14))), (12, 8)),
            "webp_lossy": (riff(b"VP8 ", b"\0\0\0\x9d\x01\x2a" + struct.pack("<HH", 12, 8)), (12, 8)),
            "jpeg": (jpeg + b"\xff\xda", (12, 8)),
            "jpeg_rotated": (jpeg + b"\xff\xe1" + struct.pack(">H", len(exif) + 2) + exif + b"\xff\xda", (8, 12)),
            "invalid": (b"not an image", None),
        }
        for name, (data, expected) in samples.items():
            with self.subTest(name=name):
                path = Path(self.temp.name).resolve() / (name + ".bin")
                path.write_bytes(data)
                self.assertEqual(self.host.content.staged_pixel_size(path), expected)
                self.assertEqual(path.read_bytes(), data)

    def test_unreadable_legacy_dimensions_stop_before_any_remote_request(self):
        self.prepare(snapshot(1))
        self.assertTrue(self.stage(0)["ok"])
        journal, _, plan = self.host.content.read(self.operation)
        for key in ("width", "height", "pixel_width", "pixel_height"):
            plan["images"][0].pop(key)
        data = b"not a decodable image header"
        self.host.content.image_path(self.operation, "Image0").write_bytes(data)
        plan["images"][0]["sha256"] = hashlib.sha256(data).hexdigest()
        self.host.content.save(self.operation, journal, plan)
        self.assertEqual(self.step()["code"], "IMAGE_DIMENSIONS_REQUIRED")
        self.assertEqual(self.cli.calls, [])

    def test_changed_legacy_staged_bytes_cannot_supply_dimensions_for_an_uploaded_token(self):
        self.prepare(snapshot(1))
        self.assertTrue(self.stage(0)["ok"])
        self.through_uploads()
        journal, _, plan = self.host.content.read(self.operation)
        for key in ("width", "height", "pixel_width", "pixel_height"):
            plan["images"][0].pop(key)
        self.host.content.image_path(self.operation, "Image0").write_bytes(png(20, 10))
        self.host.content.save(self.operation, journal, plan)
        count = len(self.cli.calls)
        self.assertEqual(self.step()["code"], "IMAGE_CONFLICT")
        self.assertEqual(len(self.cli.calls), count)

    def test_feishu_copy_preserves_existing_layout_even_when_pixel_metadata_is_supplied(self):
        self.cli = fixtures.ImportCLI()
        self.host = fixtures.native.NativeHost("/mock/lark-cli", self.directory, self.cli)
        self.assertTrue(self.call("prepare_content", token="Source")["ok"])
        data = png(1000, 500)
        result = self.call("stage_image", block_id="Image", offset=0, total_size=len(data), mime_type="image/png",
                           data_base64=base64.b64encode(data).decode(), pixel_width=1000, pixel_height=500)
        self.assertTrue(result["ok"], result)
        self.finish()
        actual = self.cli.target["NewImage"]["image"]
        self.assertEqual((actual["width"], actual["height"], actual["scale"]), (100, 50, 0.5))

    def test_callout_schema_styles_and_children_are_verified(self):
        value = snapshot(0)
        value["blocks"][0]["children"] = ["Callout"]
        value["blocks"] += [{"block_id": "Callout", "block_type": 19, "children": ["Body"],
                             "callout": {"background_color": 3, "border_color": 3, "text_color": 7, "emoji_id": "bulb"}},
                            {"block_id": "Body", "block_type": 2, "text": {"elements": [{"text_run": {"content": "保留原文提示"}}]}}]
        for key, bad in (("background_color", 16), ("border_color", 8), ("text_color", True),
                         ("emoji_id", "unknown"), ("url", "https://example.com")):
            invalid = copy.deepcopy(value)
            invalid["blocks"][1]["callout"][key] = bad
            result = self.call("prepare_web_content", source_url=invalid["source_url"], snapshot=invalid)
            self.assertEqual(result["code"], "INVALID_PARAMS")
        self.prepare(value)
        self.finish()
        self.assertEqual(self.cli.target["NewCallout"]["callout"], value["blocks"][1]["callout"])
        self.assertEqual(self.cli.target["NewCallout"]["children"], ["NewBody"])
        _, _, plan = self.host.content.read(self.operation)
        next(block for block in plan["verified_blocks"] if block["block_id"] == "NewCallout")["callout"]["background_color"] = 4
        with self.assertRaises(fixtures.native.HostError) as error:
            self.host.content.verify(plan, "Created")
        self.assertEqual(error.exception.code, "CONTENT_MISMATCH")


if __name__ == "__main__":
    unittest.main()
