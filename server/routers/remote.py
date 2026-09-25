"""FLA - 手机投屏与远程授课遥控路由 (v1.28)
支持手机端实时遥控电脑 PPT/办公文件放映：
- 翻页 / 动画步进 / 步退
- 实时激光笔同步 (手机触控板模拟红外激光点)
- 白板画笔实时同步
- 黑屏 / 计时器 / 抽选联动
- 同时支持 WebSocket 高速实时通信 与 HTTP 轮询兜底 (适配校园复杂防火墙网络)
"""
from __future__ import annotations

import asyncio
import secrets
import time
from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

router = APIRouter(prefix="/api/remote", tags=["remote"])

# 内存会话管理
SESSIONS: Dict[str, dict] = {}
MAX_SESSION_AGE = 86400  # 24小时有效


class CreateSessionReq(BaseModel):
    title: Optional[str] = "课堂放映"
    fid: Optional[int] = None
    page: Optional[int] = 1
    total: Optional[int] = 1


class UpdateStateReq(BaseModel):
    title: Optional[str] = None
    page: Optional[int] = None
    total: Optional[int] = None
    black: Optional[bool] = None


class ActionReq(BaseModel):
    action: str  # next, prev, stepNext, stepPrev, goto, laser, ink, clear, black
    data: Optional[dict] = None


def cleanup_expired():
    now = time.time()
    expired = [k for k, v in SESSIONS.items() if now - v.get("created_at", 0) > MAX_SESSION_AGE]
    for k in expired:
        SESSIONS.pop(k, None)


@router.post("/create")
def create_session(req: CreateSessionReq, request: Request):
    cleanup_expired()
    sid = secrets.token_hex(8)
    code = f"{secrets.randbelow(9000) + 1000}"  # 4位随机验证码
    session = {
        "id": sid,
        "code": code,
        "title": req.title or "课堂放映",
        "fid": req.fid,
        "page": req.page or 1,
        "total": req.total or 1,
        "black": False,
        "created_at": time.time(),
        "last_active": time.time(),
        "events": [],  # 待消费事件队列 (for HTTP poll)
        "connections": set(),  # WebSocket 活跃连接
    }
    SESSIONS[sid] = session
    return {
        "ok": True,
        "session_id": sid,
        "code": code,
        "remote_url": f"/#/remote?sid={sid}&code={code}",
        "qr_img_url": f"/api/remote/{sid}/qr",
    }


@router.get("/{sid}/qr")
@router.head("/{sid}/qr")
def get_session_qr(sid: str, request: Request):
    """返回该投屏会话的二维码直链 (PNG 图像格式，供桌面端与各类客户端原生直载渲染)."""
    session = SESSIONS.get(sid)
    if not session:
        raise HTTPException(404, "遥控会话不存在")
    import io
    try:
        import qrcode
    except ImportError:
        from ..vendor import qrcode

    base_url = str(request.base_url).rstrip("/")
    target_url = f"{base_url}/#/remote?sid={sid}&code={session['code']}"
    img = qrcode.make(target_url)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png")


@router.get("/pair/{code}")
def find_session_by_code(code: str):
    """通过 4 位配对码快速查找活跃的放映遥控会话 (供手机直接输入配对码连接)."""
    cleanup_expired()
    for sid, s in SESSIONS.items():
        if s.get("code") == code.strip():
            return {
                "ok": True,
                "session_id": sid,
                "code": s.get("code"),
                "title": s.get("title", "课堂放映"),
                "page": s.get("page", 1),
                "total": s.get("total", 1),
            }
    raise HTTPException(404, "未找到该配对码对应的放映会话，请确认大屏已开启遥控")


@router.get("/{sid}/info")
def get_session_info(sid: str, code: Optional[str] = Query(None)):
    session = SESSIONS.get(sid)
    if not session:
        raise HTTPException(404, "遥控会话不存在或已过期")
    if code and session.get("code") != code:
        raise HTTPException(403, "遥控配对验证码错误")
    session["last_active"] = time.time()
    return {
        "ok": True,
        "id": sid,
        "title": session["title"],
        "fid": session.get("fid"),
        "page": session.get("page", 1),
        "total": session.get("total", 1),
        "black": session.get("black", False),
    }


@router.post("/{sid}/state")
def update_session_state(sid: str, req: UpdateStateReq):
    session = SESSIONS.get(sid)
    if not session:
        raise HTTPException(404, "遥控会话不存在")
    if req.title is not None:
        session["title"] = req.title
    if req.page is not None:
        session["page"] = req.page
    if req.total is not None:
        session["total"] = req.total
    if req.black is not None:
        session["black"] = req.black

    # 广播状态变更通知
    evt = {"type": "state", "state": {
        "title": session["title"],
        "page": session["page"],
        "total": session["total"],
        "black": session["black"],
    }}
    _broadcast_event(session, evt)
    return {"ok": True}


@router.post("/{sid}/action")
def send_action(sid: str, req: ActionReq):
    session = SESSIONS.get(sid)
    if not session:
        raise HTTPException(404, "遥控会话不存在")
    evt = {
        "id": secrets.token_hex(4),
        "type": "action",
        "action": req.action,
        "data": req.data or {},
        "time": time.time(),
    }
    _broadcast_event(session, evt)
    return {"ok": True}


@router.get("/{sid}/poll")
def poll_events(sid: str, after: int = 0):
    session = SESSIONS.get(sid)
    if not session:
        raise HTTPException(404, "遥控会话不存在")
    evts = [e for e in session["events"] if e.get("idx", 0) > after]
    return {"ok": True, "events": evts, "latest": len(session["events"])}


def _broadcast_event(session: dict, evt: dict):
    # 加入 HTTP 轮询队列
    idx = len(session["events"]) + 1
    evt["idx"] = idx
    session["events"].append(evt)
    if len(session["events"]) > 50:
        session["events"] = session["events"][-50:]

    # 向所有活跃 WebSocket 连接广播
    for ws in list(session.get("connections", [])):
        try:
            asyncio.create_task(ws.send_json(evt))
        except Exception:
            pass


@router.websocket("/ws/{sid}")
async def remote_websocket(websocket: WebSocket, sid: str, role: str = "controller"):
    session = SESSIONS.get(sid)
    if not session:
        await websocket.close(code=4004)
        return

    await websocket.accept()
    session["connections"].add(websocket)

    # 发送当前状态
    await websocket.send_json({
        "type": "init",
        "role": role,
        "state": {
            "title": session["title"],
            "page": session["page"],
            "total": session["total"],
            "black": session["black"],
        }
    })

    # 广播 presence 事件(其余对端可见, 也进入 HTTP 轮询队列)
    _broadcast_event(session, {"type": "hello", "role": role, "time": time.time()})

    try:
        while True:
            data = await websocket.receive_json()
            # 转发至 session 所有其他对端
            evt_type = data.get("type", "action")
            broadcast_msg = {
                "type": evt_type,
                "sender": role,
                "action": data.get("action"),
                "data": data.get("data", {}),
                "time": time.time(),
            }
            # 更新状态
            if data.get("action") == "goto" and "page" in data.get("data", {}):
                session["page"] = data["data"]["page"]
            elif data.get("action") == "black":
                session["black"] = data.get("data", {}).get("black", not session["black"])

            _broadcast_event(session, broadcast_msg)
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        session["connections"].discard(websocket)
        _broadcast_event(session, {"type": "bye", "role": role, "time": time.time()})
