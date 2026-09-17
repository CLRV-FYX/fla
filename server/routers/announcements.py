"""FLA v1.26 - 公告: 用户端读取/已读 (管理端 CRUD 在 admin.py)"""
from fastapi import APIRouter, Request
from pydantic import BaseModel

from .. import db
from ..deps import require_user

router = APIRouter(prefix="/api/announcements")


@router.get("")
def my_announcements(request: Request):
    u = require_user(request)
    rows = db.q(
        "SELECT * FROM announcements WHERE active=1 AND (scope='global' OR (scope='user' AND target_uid=?))"
        " ORDER BY (level='imp') DESC, id DESC LIMIT 60", (u["id"],))
    reads = {r["aid"] for r in db.q("SELECT aid FROM ann_reads WHERE uid=?", (u["id"],))}
    items = [{"id": r["id"], "title": r["title"], "content": r["content"], "level": r["level"],
              "scope": r["scope"], "personal": r["scope"] == "user",
              "created_at": r["created_at"], "updated_at": r["updated_at"],
              "read": r["id"] in reads} for r in rows]
    return {"items": items, "unread": sum(1 for x in items if not x["read"])}


class ReadIn(BaseModel):
    ids: list[int]


@router.post("/read")
def mark_read(body: ReadIn, request: Request):
    u = require_user(request)
    for aid in body.ids[:200]:
        db.ex("INSERT OR IGNORE INTO ann_reads(uid,aid,read_at) VALUES(?,?,?)", (u["id"], aid, db.now()))
    return {"ok": True}
