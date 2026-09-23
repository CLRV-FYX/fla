"""FLA Desktop 单文件可执行程序 (FLA.exe) 构建脚本
将 Windows PE 启动存根与 FLA 客户端完整代码包合成为便携式单 EXE。
用户在 Windows 上双击 FLA.exe 即可直接运行，轻量高效，无需安装。
"""
from __future__ import annotations

import io
import os
from pathlib import Path
import subprocess
import sys
import zipfile

DESKTOP_DIR = Path(__file__).resolve().parent
DIST_DIR = DESKTOP_DIR / "dist"
OUTPUT_EXE = DIST_DIR / "FLA.exe"


def create_zip_payload() -> bytes:
    """打包 desktop 模块及其全部脚本与资源为 zip 字节流"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for file in DESKTOP_DIR.glob("*.py"):
            zf.write(file, f"desktop/{file.name}")
        for file in DESKTOP_DIR.glob("*.bat"):
            zf.write(file, f"desktop/{file.name}")
        for file in DESKTOP_DIR.glob("*.md"):
            zf.write(file, f"desktop/{file.name}")
    return buf.getvalue()


def build_pe_stub(output_path: Path):
    """使用 as + ld 编译 Windows x86_64 PE 独立启动存根"""
    launcher_s = DESKTOP_DIR / "launcher.s"
    obj_path = DIST_DIR / "launcher.o"
    DIST_DIR.mkdir(parents=True, exist_ok=True)

    subprocess.run(["as", "--64", "-o", str(obj_path), str(launcher_s)], check=True)
    subprocess.run(
        ["ld", "-m", "i386pep", "--subsystem", "windows", "-e", "_start", "-o", str(output_path), str(obj_path)],
        check=True
    )
    if obj_path.exists():
        obj_path.unlink()


def package():
    DIST_DIR.mkdir(parents=True, exist_ok=True)
    stub_exe = DIST_DIR / "stub.exe"
    build_pe_stub(stub_exe)

    stub_bytes = stub_exe.read_bytes()
    zip_bytes = create_zip_payload()

    # 组合为包含嵌入式 payload 的 Windows 单 EXE
    combined = stub_bytes + zip_bytes
    OUTPUT_EXE.write_bytes(combined)
    stub_exe.unlink()
    print(f"✔ 成功生成 Windows 单文件客户端: {OUTPUT_EXE} ({len(combined)} 字节)")


if __name__ == "__main__":
    package()
