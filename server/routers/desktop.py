"""FLA 桌面客户端分发与版本自动检测接口.
所有接口无需登录即可公开访问 (支持官网一键免登录直连下载与客户端原地静默更新).
"""
from __future__ import annotations

from pathlib import Path
from fastapi import APIRouter
from fastapi.responses import FileResponse

from server.desktop_dist import ensure_desktop_exe

router = APIRouter(prefix="/api/desktop", tags=["desktop"])

CURRENT_VERSION = "2.0.0"
CHANGELOG = [
    "v2.0 全原生重构：纯 Win32 单文件，零运行时依赖（无需 .NET、无需安装任何环境）",
    "体积更小、启动更快，杀毒软件误报大幅降低",
    "v2.0 悬浮工具盒：激光笔/画笔/荧光笔/橡皮，板书随 PPT 翻页自动保存与恢复",
    "v2.0 课堂计时器/秒表、画笔调色盘、白板一键切换、Esc 快速退出批注",
    "双击课件调用本机 PowerPoint / WPS 全屏放映，自动挂接悬浮工具盒",
    "手机扫码投屏与双向实时遥控（激光笔坐标、翻页、黑板）",
    "希沃白板5工具条智能拦截与自动保护",
    "客户端内置版本自动检测与原地静默更新",
]


@router.get("/version")
def get_desktop_version():
    """获取当前最新客户端版本信息及更新说明 (供客户端启动时自动比对自更新)."""
    exe_path = ensure_desktop_exe()
    file_size = exe_path.stat().st_size if exe_path.exists() else 0
    return {
        "ok": True,
        "version": CURRENT_VERSION,
        "name": "FLA 课堂助手",
        "download_url": "/api/desktop/download",
        "release_date": "2026-09-25",
        "size": file_size,
        "changelog": CHANGELOG,
    }


@router.get("/download")
def download_desktop_exe():
    """免登录直接下载 Windows 桌面客户端单文件可执行程序 (FLA.exe)."""
    exe_path = ensure_desktop_exe()
    return FileResponse(
        path=str(exe_path),
        filename="FLA.exe",
        media_type="application/vnd.microsoft.portable-executable",
        headers={
            "Content-Disposition": 'attachment; filename="FLA.exe"',
            "Cache-Control": "no-cache, must-revalidate",
        },
    )
