#!/usr/bin/env python3
"""Install only the local connector; never install/authenticate lark-cli."""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import sys

HOST_NAME = "com.feishu.clipper"


def installation_paths(home, platform, browser):
    home = Path(home)
    if platform == "darwin":
        support = home / "Library/Application Support"
        folders = {"chrome": "Google/Chrome", "edge": "Microsoft Edge", "chromium": "Chromium", "dia": "Dia"}
        return support / "FeishuClipper/native-host", support / folders[browser] / "NativeMessagingHosts"
    if platform.startswith("linux"):
        if browser == "dia":
            raise ValueError("Dia 连接器仅支持 macOS。")
        config = home / ".config"
        folders = {"chrome": "google-chrome", "edge": "microsoft-edge", "chromium": "chromium"}
        return home / ".local/share/feishu-clipper/native-host", config / folders[browser] / "NativeMessagingHosts"
    raise ValueError("目前仅支持 macOS 和 Linux。")


def reject_symlinks(path):
    for item in (path, *path.parents):
        if item.is_symlink():
            raise ValueError("安装目标不能使用符号链接。")


def render_files(extension_id, host_source, python, lark, node, install_dir):
    origin = "chrome-extension://" + extension_id + "/"
    launcher = install_dir / "launch.py"
    state = install_dir / "state"
    # Retain known absolute executable directories so npm's /usr/bin/env node works.
    dirs = [str(Path(node).parent), str(Path(lark).parent), str(Path(python).parent),
            "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    path_value = os.pathsep.join(dict.fromkeys(dirs))
    script = ("#!" + str(python) + "\nimport os, sys\n"
              "env = os.environ.copy()\n"
              "env['PATH'] = " + repr(path_value) + "\n"
              "os.execve(" + repr(str(python)) + ", " + repr([str(python), str(host_source),
              "--lark-cli", str(lark), "--state-dir", str(state), "--allowed-origin", origin])
              + " + sys.argv[1:], env)\n")
    manifest = {"name": HOST_NAME, "description": "飞书剪存本机连接器", "path": str(launcher),
                "type": "stdio", "allowed_origins": [origin]}
    return script, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"


def install(extension_id, browser="chrome", force=False, home=None, platform=None,
            python=None, lark=None, node=None):
    if not isinstance(extension_id, str) or not re.fullmatch(r"[a-p]{32}", extension_id):
        raise ValueError("扩展 ID 必须为 32 位 a-p 小写字母。")
    platform = platform or sys.platform
    home = Path(home or Path.home()).absolute()
    install_dir, manifest_dir = installation_paths(home, platform, browser)
    source = Path(__file__).resolve().with_name("feishu_native_host.py")
    python = Path(python or sys.executable).absolute()
    lark_value = lark or shutil.which("lark-cli")
    node_value = node or shutil.which("node")
    if not lark_value or not node_value:
        raise ValueError("未找到 lark-cli 或 node。请先安装并配置飞书 CLI，再执行本脚本。")
    lark, node = Path(lark_value).absolute(), Path(node_value).absolute()
    for executable in (python, lark, node):
        if not executable.is_file() or not os.access(executable, os.X_OK) or "\n" in str(executable):
            raise ValueError("Python、lark-cli 或 node 的可执行路径无效。")
    if not source.is_file():
        raise ValueError("缺少 feishu_native_host.py，请在完整插件目录中运行安装脚本。")
    launcher_text, manifest_text = render_files(extension_id, source, python, lark, node, install_dir)
    writes = [(install_dir / "launch.py", launcher_text, 0o700),
              (manifest_dir / (HOST_NAME + ".json"), manifest_text, 0o600)]
    # Preflight every target before any write. A different extension requires explicit --force.
    for path, content, _ in writes:
        reject_symlinks(path)
        if path.exists() and (not path.is_file() or path.read_text(encoding="utf-8") != content and not force):
            raise ValueError("已有不同的连接器配置，未覆盖。确认替换后可添加 --force。")
    for directory in (install_dir, manifest_dir, install_dir / "state"):
        reject_symlinks(directory)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(install_dir, 0o700)
    os.chmod(install_dir / "state", 0o700)
    for path, content, mode in writes:
        if not path.exists() or path.read_text(encoding="utf-8") != content:
            flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW
            fd = os.open(path, flags, mode)
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                stream.write(content)
        os.chmod(path, mode)
    return {"manifest": str(writes[1][0]), "launcher": str(writes[0][0]), "state_dir": str(install_dir / "state")}


def main():
    parser = argparse.ArgumentParser(description="安装飞书剪存本机连接器，不安装 CLI、不登录飞书。")
    parser.add_argument("--extension-id", required=True)
    parser.add_argument("--browser", choices=("chrome", "edge", "chromium", "dia"), default="chrome")
    parser.add_argument("--force", action="store_true", help="显式替换已有不同扩展或路径配置")
    args = parser.parse_args()
    try:
        result = install(args.extension_id, args.browser, args.force)
    except ValueError as error:
        print("安装未完成：" + str(error), file=sys.stderr)
        return 1
    except OSError:
        print("安装未完成：无法读写本机安装目录，请检查目录权限。", file=sys.stderr)
        return 1
    print("本机连接器已安装。请重新打开剪存页或点击重新检测；会自动使用已有授权，仅未登录或授权失效时才需登录。")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
