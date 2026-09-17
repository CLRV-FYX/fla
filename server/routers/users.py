"""FLA - 用户路由: 资料 / 头像"""
import re
import secrets
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import db
from ..deps import require_user, user_public

router = APIRouter(prefix="/api/users")

AVATAR_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
AVATAR_EXT = {"png", "jpg", "jpeg", "webp", "gif"}


class ProfileIn(BaseModel):
    nickname: str | None = None
    signature: str | None = None


@router.put("/profile")
def update_profile(body: ProfileIn, request: Request):
    u = require_user(request)
    if body.nickname is not None:
        nk = body.nickname.strip()
        if not (1 <= len(nk) <= 32):
            raise HTTPException(400, "昵称需 1-32 个字符")
        db.ex("UPDATE users SET nickname=? WHERE id=?", (nk, u["id"]))
    if body.signature is not None:
        if len(body.signature) > 200:
            raise HTTPException(400, "签名最多 200 字")
        db.ex("UPDATE users SET signature=? WHERE id=?", (body.signature, u["id"]))
    return user_public(db.q1("SELECT * FROM users WHERE id=?", (u["id"],)))


@router.post("/avatar")
async def upload_avatar(request: Request, file: UploadFile = File(...)):
    u = require_user(request)
    ext = Path(file.filename or "").suffix.lower().lstrip(".")
    if ext not in AVATAR_EXT:
        raise HTTPException(400, "头像仅支持 png / jpg / webp / gif")
    data = await file.read()
    if len(data) > 8 * 1024 * 1024:
        raise HTTPException(400, "头像不能超过 8MB")
    if not data:
        raise HTTPException(400, "空文件")
    name = f"u{u['id']}_{secrets.token_hex(6)}.{ext}"
    (db.DATA / "avatars" / name).write_bytes(data)
    if u["avatar"]:
        old = db.DATA / "avatars" / Path(u["avatar"]).name
        if AVATAR_RE.match(old.name) and old.exists():
            old.unlink()
    url = f"/api/avatars/{name}"
    db.ex("UPDATE users SET avatar=? WHERE id=?", (url, u["id"]))
    return {"avatar": url}


# 头像公开可读(文件名不可猜测)
avatars = APIRouter(prefix="/api/avatars")


@avatars.get("/{name}")
def avatar_file(name: str):
    if not AVATAR_RE.match(name):
        raise HTTPException(404)
    p = db.DATA / "avatars" / name
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(str(p), headers={"Cache-Control": "public, max-age=300"})
