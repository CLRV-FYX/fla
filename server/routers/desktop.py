"""FLA 桌面客户端分发与版本自动检测接口.
所有接口无需登录即可公开访问 (支持官网一键免登录直连下载与客户端原地静默更新).
"""
from __future__ import annotations

from pathlib import Path
from fastapi import APIRouter
from fastapi.responses import FileResponse

from server.desktop_dist import ensure_desktop_exe

router = APIRouter(prefix="/api/desktop", tags=["desktop"])

CURRENT_VERSION = "3.2.0"
CHANGELOG = [
    "v3.2.0: 自动识别 PowerPoint/WPS 放映，切换为 PPT 专用工具栏，画布按幻灯片页保存，翻页播放动画",
    "v3.2.0: 未放映时翻页按钮把翻页键发给当前窗口；桌面画布自动保存到本地",
    "v3.2.0: 工具栏新增拖动把手；手机整屏无线镜像入口；修复扫码登录二维码加载失败",
    "v3.1 手机投屏：扫码即可在手机上实时观看电脑屏幕，并用画笔/荧光笔/激光笔/橡皮直接在大屏批注、翻页",
    "v3.1 手机摄像头/照片一键投到大屏，大屏上可继续批注",
    "修复：画笔状态下工具栏区域永不被画布遮挡，任何时候都能点工具栏退出（托盘菜单也可“退出批注”）",
    "橡皮：再点一次可选大小（小/中/大）与对象橡皮/像素橡皮",
    "画笔/荧光笔：再点一次弹出颜色与粗细",
    "新增撤销按钮；服务器线路仅可选 t.clrv.top / t.fyx.best",
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
