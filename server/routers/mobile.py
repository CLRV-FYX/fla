"""手机端分发: 安卓 APK (GitHub Actions 自动构建后提交到 mobile/bin/FLA.apk)"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

router = APIRouter(prefix="/api/app", tags=["mobile"])
ROOT = Path(__file__).resolve().parents[2]
APK = ROOT / "mobile" / "bin" / "FLA.apk"


@router.get("/info")
def app_info():
    ok = APK.exists() and APK.stat().st_size > 10000
    return {
        "android": {"available": ok, "url": "/api/app/android", "size": APK.stat().st_size if ok else 0},
        "ios": {"available": False, "web": "/cast.html"},
    }


@router.get("/android")
def download_apk():
    if not APK.exists():
        raise HTTPException(404, "安卓安装包尚未构建，请稍后再试")
    return FileResponse(str(APK), filename="FLA-cast.apk", media_type="application/vnd.android.package-archive",
                        headers={"Content-Disposition": 'attachment; filename="FLA-cast.apk"', "Cache-Control": "no-cache"})
