"""FLA 桌面客户端分发与版本自动检测接口.
所有接口无需登录即可公开访问 (支持官网一键免登录直连下载与客户端原地静默更新).
"""
from __future__ import annotations

from pathlib import Path
from fastapi import APIRouter
from fastapi.responses import FileResponse

from server.desktop_dist import ensure_desktop_exe

router = APIRouter(prefix="/api/desktop", tags=["desktop"])

CURRENT_VERSION = "1.36.0"
CHANGELOG = [
    "桌面端重写升级：全面超越希沃白板5",
    "边缘吸附磨砂玻璃悬浮助手与全能教学工具条",
    "7种专业学科背景白板（田字格/四线格/五线谱/坐标网格/护眼绿/黑板/白板）",
    "全套课堂互动工具箱：倒计时秒表、随机点名抽选神器、四向遮挡幕布、聚光灯、草稿纸",
    "希沃白板5工具条智能拦截与自动保护",
    "板书画布随 PPT/WPS 幻灯片翻页严格同步移动与隔离存储",
    "手机无线扫码投屏与双向实时遥控",
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
        "release_date": "2026-09-23",
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
