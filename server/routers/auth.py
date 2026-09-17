"""FLA - 认证路由: 注册(邀请码) / 登录 / 个人信息 / 改密"""
import re

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from .. import db
from ..deps import require_user, user_public
from ..security import hash_password, make_token, verify_password

router = APIRouter(prefix="/api/auth")

USERNAME_RE = re.compile(r"^[A-Za-z0-9_\u4e00-\u9fa5]{3,32}$")


class RegIn(BaseModel):
    username: str
    password: str
    nickname: str = ""
    invite_code: str


class LoginIn(BaseModel):
    username: str
    password: str


class PwIn(BaseModel):
    old_password: str
    new_password: str


class QrApproveIn(BaseModel):
    ticket: str


@router.get("/config")
def config():
    return {"registration_open": db.get_setting("registration_open", "1") == "1", "site_bg": db.get_setting("site_bg", "")}


@router.post("/register")
def register(body: RegIn):
    if db.get_setting("registration_open", "1") != "1":
        raise HTTPException(403, "注册已关闭")
    if not USERNAME_RE.match(body.username or ""):
        raise HTTPException(400, "用户名需 3-32 位, 仅限中英文、数字、下划线")
    if len(body.password or "") < 6:
        raise HTTPException(400, "密码至少 6 位")
    if len(body.password.encode()) > 72:
        raise HTTPException(400, "密码过长")
    inv = db.q1("SELECT * FROM invite_codes WHERE code=?", (body.invite_code.strip(),))
    if not inv:
        raise HTTPException(400, "邀请码无效")
    if inv["expires_at"] and inv["expires_at"] < db.now():
        raise HTTPException(400, "邀请码已过期")
    if inv["used_count"] >= inv["max_uses"]:
        raise HTTPException(400, "邀请码已被用完")
    if db.q1("SELECT id FROM users WHERE username=?", (body.username,)):
        raise HTTPException(400, "用户名已存在")
    cur = db.ex("UPDATE invite_codes SET used_count=used_count+1 WHERE id=? AND used_count < max_uses",
                (inv["id"],))
    if cur.rowcount == 0:
        raise HTTPException(400, "邀请码已被用完")
    quota = int(db.get_setting("default_quota_mb", "500")) * 1024 * 1024
    db.ex("INSERT INTO users(username,password_hash,nickname,quota_bytes,created_at) VALUES(?,?,?,?,?)",
          (body.username, hash_password(body.password),
           (body.nickname or "").strip()[:32] or body.username, quota, db.now()))
    u = db.q1("SELECT * FROM users WHERE username=?", (body.username,))
    return {"token": make_token(u), "user": user_public(u)}


@router.post("/login")
def login(body: LoginIn):
    u = db.q1("SELECT * FROM users WHERE username=?", ((body.username or "").strip(),))
    if not u or not verify_password(body.password or "", u["password_hash"]):
        raise HTTPException(400, "用户名或密码错误")
    db.ex("UPDATE users SET last_login_at=? WHERE id=?", (db.now(), u["id"]))
    u = db.q1("SELECT * FROM users WHERE id=?", (u["id"],))
    return {"token": make_token(u), "user": user_public(u)}


@router.get("/me")
def me(request: Request):
    return user_public(require_user(request))


@router.post("/change_password")
def change_password(body: PwIn, request: Request):
    u = require_user(request)
    if not verify_password(body.old_password or "", u["password_hash"]):
        raise HTTPException(400, "原密码错误")
    if len(body.new_password or "") < 6:
        raise HTTPException(400, "新密码至少 6 位")
    if len(body.new_password.encode()) > 72:
        raise HTTPException(400, "密码过长")
    db.ex("UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?",
          (hash_password(body.new_password), u["id"]))
    return {"ok": True}


# ================================ v1.26 扫码登录 ================================
# 流程: 登录页 POST /qr/ticket 生成一次性票据并展示二维码(内容=授权URL)
#       → 已登录设备打开该 URL(或App内扫码) POST /qr/approve 授权
#       → 登录页轮询 GET /qr/status 取回 token
import secrets as _secrets
import time as _time

QR_TTL = 150  # 票据有效期(秒)


def _qr_gc():
    """清理过期票据(顺带防表膨胀)"""
    try:
        db.ex("DELETE FROM qr_tickets WHERE expires < ?", (_time.time() - 3600,))
    except Exception:
        pass


@router.post("/qr/ticket")
def qr_ticket():
    _qr_gc()
    ticket = "qr" + _secrets.token_hex(16)
    db.ex("INSERT INTO qr_tickets(ticket,expires,status) VALUES(?,?,?)",
          (ticket, _time.time() + QR_TTL, "pending"))
    return {"ticket": ticket, "expires_in": QR_TTL}


@router.post("/qr/approve")
def qr_approve(body: QrApproveIn, request: Request):
    u = require_user(request)
    _qr_gc()
    t = db.q1("SELECT * FROM qr_tickets WHERE ticket=?", (body.ticket.strip(),))
    if not t:
        raise HTTPException(404, "二维码无效或已过期, 请刷新后重扫")
    if t["expires"] < _time.time() or t["status"] != "pending":
        raise HTTPException(410, "二维码已过期, 请刷新后重扫")
    db.ex("UPDATE qr_tickets SET status='ok', uid=?, token=? WHERE ticket=?",
          (u["id"], make_token(u), body.ticket.strip()))
    return {"ok": True}


@router.get("/qr/status")
def qr_status(ticket: str):
    _qr_gc()
    t = db.q1("SELECT * FROM qr_tickets WHERE ticket=?", ((ticket or "").strip(),))
    if not t:
        return {"status": "invalid"}
    if t["expires"] < _time.time():
        return {"status": "expired"}
    if t["status"] == "ok" and t["token"]:
        # 一次性: 取走即作废
        db.ex("UPDATE qr_tickets SET status='used', token=NULL WHERE ticket=?", (t["ticket"],))
        u = db.q1("SELECT * FROM users WHERE id=?", (t["uid"],))
        return {"status": "ok", "token": t["token"], "user": user_public(u)}
    return {"status": "pending"}
