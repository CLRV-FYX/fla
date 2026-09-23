"""FLA 桌面客户端分发与版本自动检测接口.
所有接口无需登录即可公开访问 (支持官网一键免登录直连下载与客户端原地静默更新).
"""
from __future__ import annotations

import io
import os
from pathlib import Path
import zipfile

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

router = APIRouter(prefix="/api/desktop", tags=["desktop"])

DESKTOP_DIR = Path(__file__).resolve().parent.parent.parent / "desktop"
EXE_PATH = DESKTOP_DIR / "dist" / "FLA.exe"

CURRENT_VERSION = "1.28.0"
CHANGELOG = [
    "全新现代 Fluent 质感 UI，轻量高效",
    "希沃白板5工具条智能拦截与自动保护",
    "板书画布随 PPT 幻灯片翻页严格同步移动",
    "手机无线扫码投屏与双向实时遥控",
    "客户端内置版本自动检测与原地静默更新",
]


@router.get("/version")
def get_desktop_version():
    """获取当前最新客户端版本信息及更新说明 (供客户端启动时自动比对自更新)."""
    file_size = EXE_PATH.stat().st_size if EXE_PATH.exists() else 0
    return {
        "ok": True,
        "version": CURRENT_VERSION,
        "name": "FLA 课堂助手",
        "download_url": "/api/desktop/download",
        "release_date": "2026-09-23",
        "size": file_size,
        "changelog": CHANGELOG,
    }


@router.get("/download")
def download_desktop_exe():
    """免登录直接下载 Windows 桌面客户端单文件可执行程序 (FLA.exe)."""
    # 若不存在，尝试自动构建生成
    if not (EXE_PATH.exists() and EXE_PATH.stat().st_size > 0):
        try:
            from desktop.package_exe import package
            package()
        except Exception:
            pass

    # 若 dist/FLA.exe 存在直接返回
    if EXE_PATH.exists() and EXE_PATH.stat().st_size > 0:
        return FileResponse(
            path=str(EXE_PATH),
            filename="FLA.exe",
            media_type="application/vnd.microsoft.portable-executable",
            headers={"Cache-Control": "no-cache, must-revalidate"},
        )

    # 兜底：如果尚未生成则动态打包为 ZIP 格式
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for file in DESKTOP_DIR.glob("*.py"):
            zf.write(file, f"desktop/{file.name}")
        for file in DESKTOP_DIR.glob("*.bat"):
            zf.write(file, f"desktop/{file.name}")
        for file in DESKTOP_DIR.glob("*.md"):
            zf.write(file, f"desktop/{file.name}")
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=FLA-Desktop.zip"},
    )
