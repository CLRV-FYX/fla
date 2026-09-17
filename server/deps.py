"""FLA - 请求依赖: 鉴权 / 管理员校验 / 用户公开字段"""
from fastapi import HTTPException, Request

from . import db
from .security import decode_token


def _token_from(request: Request) -> str:
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return request.query_params.get("token", "")


def load_user(request: Request):
    token = _token_from(request)
    if not token:
        return None
    data = decode_token(token)
    if not data:
        return None
    try:
        return db.q1("SELECT * FROM users WHERE id=?", (int(data["sub"]),))
    except Exception:
        return None


def require_user(request: Request):
    u = load_user(request)
    if not u:
        raise HTTPException(401, "请先登录")
    return u


def require_admin(request: Request):
    u = require_user(request)
    if u["role"] != "admin":
        raise HTTPException(403, "需要管理员权限")
    return u


def user_public(u):
    if u is None:
        return None
    return {
        "id": u["id"],
        "username": u["username"],
        "nickname": u["nickname"] or u["username"],
        "signature": u["signature"],
        "avatar": u["avatar"],
        "role": u["role"],
        "is_teacher": bool(u["is_teacher"]),
        "cert_title": u["cert_title"],
        "cert_icon": u["cert_icon"] if "cert_icon" in u.keys() else "",
        "cert_color": u["cert_color"] if "cert_color" in u.keys() else "",
        "chat_banned": bool(u["chat_banned"]) if "chat_banned" in u.keys() else False,
        "quota_bytes": u["quota_bytes"],
        "used_bytes": db.used_bytes(u["id"]),
        "must_change_password": bool(u["must_change_password"]),
        "created_at": u["created_at"],
        "last_login_at": u["last_login_at"],
    }
