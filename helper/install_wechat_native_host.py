#!/usr/bin/env python3
"""Register the WeChat list host without changing the existing Feishu host."""

import argparse
import json
import os
from pathlib import Path
import re
import sys
from install_feishu_native_host import installation_paths, reject_symlinks

HOST = "com.wechat.clipper"


def install(extension_id, browser="chrome", home=None, platform=None):
    if not isinstance(extension_id, str) or not re.fullmatch(r"[a-p]{32}", extension_id):
        raise ValueError("扩展 ID 格式无效。")
    platform = platform or sys.platform
    base = Path(home or Path.home())
    if browser == "chrome-testing" and platform == "darwin":
        install_dir = base / "Library/Application Support/FeishuClipper/native-host"
        manifest_dir = base / "Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts"
    else:
        install_dir, manifest_dir = installation_paths(base, platform, browser)
    source = Path(__file__).resolve().with_name("wechat_native_host.py")
    for name in ("wechat_native_host.py", "tikhub_wechat.py", "feishu_native_host.py"):
        if not source.with_name(name).is_file():
            raise ValueError("请在完整插件源码目录安装公众号连接器。")
    python = str(Path(sys.executable).absolute())
    origin = "chrome-extension://" + extension_id + "/"
    launcher = install_dir / "wechat-launch.py"
    state = install_dir / "wechat-state"
    text = ("#!" + python + "\nimport os, sys\n"
            + "os.execve(" + repr(python) + ", "
            + repr([python, str(source), "--state-dir", str(state), "--allowed-origin", origin])
            + " + sys.argv[1:], os.environ.copy())\n")
    manifest = {"name": HOST, "description": "公众号历史文章本机连接器", "type": "stdio",
                "path": str(launcher), "allowed_origins": [origin]}
    writes = [(launcher, text, 0o700), (manifest_dir / (HOST + ".json"), json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", 0o600)]
    for path, value, _ in writes:
        reject_symlinks(path)
        if path.exists() and (not path.is_file() or path.read_text() != value):
            raise ValueError("已有不同的公众号连接器配置，未覆盖。")
    for directory in (install_dir, manifest_dir, state):
        reject_symlinks(directory)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    for path, value, mode in writes:
        if not path.exists():
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                stream.write(value)
        os.chmod(path, mode)
    return {"manifest": str(writes[1][0]), "launcher": str(launcher), "state_dir": str(state)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--extension-id", required=True)
    parser.add_argument("--browser", choices=("chrome", "edge", "chromium", "dia", "chrome-testing"), default="chrome")
    args = parser.parse_args()
    try:
        print(json.dumps(install(args.extension_id, args.browser), ensure_ascii=False))
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
