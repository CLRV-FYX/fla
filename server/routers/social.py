"""FLA v1.26 - 社区: 论坛(板块/帖子/回复) + 聊天(群组/实时消息)
管理员可编辑/删除任意内容, 权限(允许建群等)由系统设置控制"""
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from .. import db
from ..deps import require_user

router = APIRouter(prefix="/api")


def _user_card(uid):
    r = db.q1("SELECT id,username,nickname,avatar,role,is_teacher,cert_title,cert_icon,cert_color FROM users WHERE id=?", (uid,))
    if not r:
        return {"id": 0, "username": "?", "nickname": "已注销用户", "avatar": "", "role": "user",
                "is_teacher": False, "cert_title": "", "cert_icon": "", "cert_color": ""}
    return {"id": r["id"], "username": r["username"], "nickname": r["nickname"] or r["username"],
            "avatar": r["avatar"], "role": r["role"], "is_teacher": bool(r["is_teacher"]),
            "cert_title": r["cert_title"], "cert_icon": r["cert_icon"], "cert_color": r["cert_color"]}


def _clean(s, n):
    s = (s or "").strip()
    return s[:n]


# ================================ 论坛 ================================

@router.get("/forum/boards")
def forum_boards(request: Request):
    require_user(request)
    rows = db.q("SELECT b.*, (SELECT COUNT(*) FROM forum_threads t WHERE t.board_id=b.id) AS threads"
                " FROM forum_boards b ORDER BY b.sort, b.id")
    return {"items": [{"id": r["id"], "name": r["name"], "descr": r["descr"],
                       "threads": r["threads"]} for r in rows]}


@router.get("/forum/threads")
def forum_threads(request: Request, board: int = 0, page: int = 1):
    u = require_user(request)
    size = 15
    page = max(1, page)
    where, args = "", []
    if board:
        where = "WHERE t.board_id=?"
        args.append(board)
    total = db.q1(f"SELECT COUNT(*) AS c FROM forum_threads t {where}", tuple(args))["c"]
    rows = db.q(
        f"SELECT t.* FROM forum_threads t {where}"
        " ORDER BY t.pinned DESC, t.updated_at DESC LIMIT ? OFFSET ?", tuple(args + [size, (page - 1) * size]))
    items = []
    for r in rows:
        cnt = db.q1("SELECT COUNT(*) AS c FROM forum_posts WHERE thread_id=?", (r["id"],))["c"]
        last = db.q1("SELECT created_at FROM forum_posts WHERE thread_id=? ORDER BY id DESC LIMIT 1", (r["id"],))
        items.append({"id": r["id"], "board_id": r["board_id"], "title": r["title"],
                      "pinned": bool(r["pinned"]), "locked": bool(r["locked"]),
                      "replies": cnt, "author": _user_card(r["user_id"]),
                      "created_at": r["created_at"], "updated_at": r["updated_at"],
                      "last_reply_at": (last["created_at"] if last else r["created_at"]),
                      "mine": r["user_id"] == u["id"]})
    return {"items": items, "total": total, "page": page, "pages": max(1, -(-total // size))}


class ThreadIn(BaseModel):
    board_id: int
    title: str
    content: str


@router.post("/forum/threads")
def create_thread(body: ThreadIn, request: Request):
    u = require_user(request)
    if db.get_setting("forum_enabled", "1") != "1" and u["role"] != "admin":
        raise HTTPException(403, "论坛已由管理员关闭")
    board = db.q1("SELECT id FROM forum_boards WHERE id=?", (body.board_id,))
    if not board:
        raise HTTPException(404, "板块不存在")
    title = _clean(body.title, 100)
    content = _clean(body.content, 8000)
    if len(title) < 2:
        raise HTTPException(400, "标题太短")
    if not content:
        raise HTTPException(400, "内容不能为空")
    now = db.now()
    cur = db.ex("INSERT INTO forum_threads(board_id,user_id,title,content,created_at,updated_at)"
                " VALUES(?,?,?,?,?,?)", (body.board_id, u["id"], title, content, now, now))
    return {"id": cur.lastrowid}


def _get_thread(tid):
    t = db.q1("SELECT * FROM forum_threads WHERE id=?", (tid,))
    if not t:
        raise HTTPException(404, "帖子不存在")
    return t


@router.get("/forum/threads/{tid}")
def thread_detail(tid: int, request: Request, page: int = 1):
    u = require_user(request)
    t = _get_thread(tid)
    size = 20
    page = max(1, page)
    total = db.q1("SELECT COUNT(*) AS c FROM forum_posts WHERE thread_id=?", (tid,))["c"]
    rows = db.q("SELECT * FROM forum_posts WHERE thread_id=? ORDER BY id LIMIT ? OFFSET ?",
                (tid, size, (page - 1) * size))
    posts = [{"id": r["id"], "content": r["content"], "author": _user_card(r["user_id"]),
              "edited": bool(r["edited"]), "edited_by_admin": bool(r["edited_by"]) and r["user_id"] != r["edited_by"],
              "created_at": r["created_at"], "mine": r["user_id"] == u["id"]} for r in rows]
    return {"id": t["id"], "board_id": t["board_id"], "title": t["title"], "content": t["content"],
            "pinned": bool(t["pinned"]), "locked": bool(t["locked"]),
            "author": _user_card(t["user_id"]), "created_at": t["created_at"],
            "mine": t["user_id"] == u["id"], "posts": posts,
            "total": total, "page": page, "pages": max(1, -(-total // size))}


class PostIn(BaseModel):
    content: str


@router.post("/forum/threads/{tid}/posts")
def create_post(tid: int, body: PostIn, request: Request):
    u = require_user(request)
    if db.get_setting("forum_enabled", "1") != "1" and u["role"] != "admin":
        raise HTTPException(403, "论坛已由管理员关闭")
    t = _get_thread(tid)
    if t["locked"] and u["role"] != "admin":
        raise HTTPException(403, "帖子已锁定")
    content = _clean(body.content, 8000)
    if not content:
        raise HTTPException(400, "回复内容不能为空")
    db.ex("INSERT INTO forum_posts(thread_id,user_id,content,created_at) VALUES(?,?,?,?)",
          (tid, u["id"], content, db.now()))
    db.ex("UPDATE forum_threads SET updated_at=? WHERE id=?", (db.now(), tid))
    return {"ok": True}


class ThreadPatch(BaseModel):
    title: str | None = None
    content: str | None = None
    pinned: bool | None = None
    locked: bool | None = None


@router.patch("/forum/threads/{tid}")
def patch_thread(tid: int, body: ThreadPatch, request: Request):
    u = require_user(request)
    t = _get_thread(tid)
    admin = u["role"] == "admin"
    if t["user_id"] != u["id"] and not admin:
        raise HTTPException(403, "只能编辑自己的帖子")
    if t["locked"] and not admin:
        raise HTTPException(403, "帖子已锁定")
    if body.pinned is not None and not admin:
        raise HTTPException(403, "只有管理员能置顶")
    if body.title is not None:
        title = _clean(body.title, 100)
        if len(title) < 2:
            raise HTTPException(400, "标题太短")
        db.ex("UPDATE forum_threads SET title=? WHERE id=?", (title, tid))
    if body.content is not None:
        db.ex("UPDATE forum_threads SET content=? WHERE id=?", (_clean(body.content, 8000), tid))
    if body.pinned is not None and admin:
        db.ex("UPDATE forum_threads SET pinned=? WHERE id=?", (1 if body.pinned else 0, tid))
    if body.locked is not None and admin:
        db.ex("UPDATE forum_threads SET locked=? WHERE id=?", (1 if body.locked else 0, tid))
    db.ex("UPDATE forum_threads SET updated_at=? WHERE id=?", (db.now(), tid))
    return {"ok": True}


@router.delete("/forum/threads/{tid}")
def delete_thread(tid: int, request: Request):
    u = require_user(request)
    t = _get_thread(tid)
    if t["user_id"] != u["id"] and u["role"] != "admin":
        raise HTTPException(403, "只能删除自己的帖子")
    db.ex("DELETE FROM forum_posts WHERE thread_id=?", (tid,))
    db.ex("DELETE FROM forum_threads WHERE id=?", (tid,))
    return {"ok": True}


class PostPatch(BaseModel):
    content: str


@router.patch("/forum/posts/{pid}")
def patch_post(pid: int, body: PostPatch, request: Request):
    u = require_user(request)
    r = db.q1("SELECT * FROM forum_posts WHERE id=?", (pid,))
    if not r:
        raise HTTPException(404, "回复不存在")
    if r["user_id"] != u["id"] and u["role"] != "admin":
        raise HTTPException(403, "只能编辑自己的回复")
    content = _clean(body.content, 8000)
    if not content:
        raise HTTPException(400, "内容不能为空")
    db.ex("UPDATE forum_posts SET content=?, edited=1, edited_by=? WHERE id=?", (content, u["id"], pid))
    return {"ok": True}


@router.delete("/forum/posts/{pid}")
def delete_post(pid: int, request: Request):
    u = require_user(request)
    r = db.q1("SELECT * FROM forum_posts WHERE id=?", (pid,))
    if not r:
        raise HTTPException(404, "回复不存在")
    if r["user_id"] != u["id"] and u["role"] != "admin":
        raise HTTPException(403, "只能删除自己的回复")
    db.ex("DELETE FROM forum_posts WHERE id=?", (pid,))
    return {"ok": True}


# ================================ 聊天 ================================

def _room_out(r, uid):
    members = db.q("SELECT uid FROM chat_members WHERE room_id=?", (r["id"],))
    last = db.q1("SELECT * FROM chat_messages WHERE room_id=? AND deleted=0 ORDER BY id DESC LIMIT 1", (r["id"],))
    cnt = db.q1("SELECT COUNT(*) AS c FROM chat_messages WHERE room_id=? AND deleted=0", (r["id"],))["c"]
    return {"id": r["id"], "name": r["name"], "official": bool(r["official"]),
            "members": len(members) + (1 if r["official"] else 0),
            "joined": any(m["uid"] == uid for m in members) or bool(r["official"]),
            "messages": cnt,
            "last": ({"content": last["content"], "created_at": last["created_at"],
                      "uid": last["uid"]} if last else None)}


@router.get("/chat/rooms")
def chat_rooms(request: Request):
    u = require_user(request)
    rows = db.q("SELECT * FROM chat_rooms ORDER BY official DESC, id")
    return {"items": [_room_out(r, u["id"]) for r in rows],
            "allow_create": db.get_setting("allow_group_create", "0") == "1" or u["role"] == "admin"}


class RoomIn(BaseModel):
    name: str


@router.post("/chat/rooms")
def create_room(body: RoomIn, request: Request):
    u = require_user(request)
    if db.get_setting("chat_enabled", "1") != "1" and u["role"] != "admin":
        raise HTTPException(403, "聊天区已由管理员关闭")
    if db.get_setting("allow_group_create", "0") != "1" and u["role"] != "admin":
        raise HTTPException(403, "管理员未开放创建群组")
    name = _clean(body.name, 30)
    if len(name) < 2:
        raise HTTPException(400, "群组名太短")
    cur = db.ex("INSERT INTO chat_rooms(name,owner_id,official,created_at) VALUES(?,?,0,?)",
                (name, u["id"], db.now()))
    rid = cur.lastrowid
    db.ex("INSERT INTO chat_members(room_id,uid,joined_at) VALUES(?,?,?)", (rid, u["id"], db.now()))
    return {"id": rid}


@router.post("/chat/rooms/{rid}/join")
def join_room(rid: int, request: Request):
    u = require_user(request)
    r = db.q1("SELECT * FROM chat_rooms WHERE id=?", (rid,))
    if not r:
        raise HTTPException(404, "群组不存在")
    db.ex("INSERT OR IGNORE INTO chat_members(room_id,uid,joined_at) VALUES(?,?,?)", (rid, u["id"], db.now()))
    return {"ok": True}


@router.get("/chat/rooms/{rid}/messages")
def room_messages(rid: int, request: Request, after: int = 0, limit: int = 60):
    u = require_user(request)
    r = db.q1("SELECT * FROM chat_rooms WHERE id=?", (rid,))
    if not r:
        raise HTTPException(404, "群组不存在")
    limit = max(1, min(limit, 100))
    if after:
        rows = db.q("SELECT * FROM chat_messages WHERE room_id=? AND id>? ORDER BY id LIMIT ?",
                    (rid, after, limit))
    else:
        rows = db.q("SELECT * FROM (SELECT * FROM chat_messages WHERE room_id=? ORDER BY id DESC LIMIT ?)"
                    " ORDER BY id", (rid, limit))
    out = []
    for m in rows:
        out.append({"id": m["id"], "content": "" if m["deleted"] else m["content"],
                    "deleted": bool(m["deleted"]), "uid": m["uid"], "author": _user_card(m["uid"]),
                    "edited": bool(m["edited"]), "edited_by_admin": bool(m["edited_by"]) and m["edited_by"] != m["uid"],
                    "created_at": m["created_at"], "mine": m["uid"] == u["id"]})
    return {"items": out, "server_time": db.now()}


class MsgIn(BaseModel):
    content: str


@router.post("/chat/rooms/{rid}/messages")
def send_message(rid: int, body: MsgIn, request: Request):
    u = require_user(request)
    if "chat_banned" in u.keys() and u["chat_banned"]:
        raise HTTPException(403, "你已被管理员禁言")
    if db.get_setting("chat_enabled", "1") != "1" and u["role"] != "admin":
        raise HTTPException(403, "聊天区已由管理员关闭")
    r = db.q1("SELECT * FROM chat_rooms WHERE id=?", (rid,))
    if not r:
        raise HTTPException(404, "群组不存在")
    content = _clean(body.content, 500)
    if not content:
        raise HTTPException(400, "消息不能为空")
    db.ex("INSERT OR IGNORE INTO chat_members(room_id,uid,joined_at) VALUES(?,?,?)", (rid, u["id"], db.now()))
    cur = db.ex("INSERT INTO chat_messages(room_id,uid,content,created_at) VALUES(?,?,?,?)",
                (rid, u["id"], content, db.now()))
    return {"id": cur.lastrowid}


class MsgPatch(BaseModel):
    content: str


@router.patch("/chat/messages/{mid}")
def edit_message(mid: int, body: MsgPatch, request: Request):
    u = require_user(request)
    m = db.q1("SELECT * FROM chat_messages WHERE id=?", (mid,))
    if not m or m["deleted"]:
        raise HTTPException(404, "消息不存在")
    if m["uid"] != u["id"] and u["role"] != "admin":
        raise HTTPException(403, "只能编辑自己的消息")
    content = _clean(body.content, 500)
    if not content:
        raise HTTPException(400, "消息不能为空")
    db.ex("UPDATE chat_messages SET content=?, edited=1, edited_by=? WHERE id=?", (content, u["id"], mid))
    return {"ok": True}


@router.delete("/chat/messages/{mid}")
def delete_message(mid: int, request: Request):
    u = require_user(request)
    m = db.q1("SELECT * FROM chat_messages WHERE id=?", (mid,))
    if not m:
        raise HTTPException(404, "消息不存在")
    if m["uid"] != u["id"] and u["role"] != "admin":
        raise HTTPException(403, "只能删除自己的消息")
    db.ex("UPDATE chat_messages SET deleted=1 WHERE id=?", (mid,))
    return {"ok": True}


@router.delete("/chat/rooms/{rid}")
def delete_room(rid: int, request: Request):
    u = require_user(request)
    r = db.q1("SELECT * FROM chat_rooms WHERE id=?", (rid,))
    if not r:
        raise HTTPException(404, "群组不存在")
    if u["role"] != "admin" and r["owner_id"] != u["id"]:
        raise HTTPException(403, "只有管理员或群主可以解散群组")
    db.ex("DELETE FROM chat_messages WHERE room_id=?", (rid,))
    db.ex("DELETE FROM chat_members WHERE room_id=?", (rid,))
    db.ex("DELETE FROM chat_rooms WHERE id=?", (rid,))
    return {"ok": True}
