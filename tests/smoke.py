#!/usr/bin/env python3
"""FLA v1.27 冒烟测试 — 不需要 Docker / LibreOffice / 外网.

跑法:
    python3 tests/smoke.py            # 或 .venv/bin/python tests/smoke.py

它在一个临时数据目录里拉起 FastAPI(Starlette TestClient), 依次验证:
  1. 健康检查 / 管理员登录
  2. 上传一个"最小的真 pptx"(3 页, 16:9) → 微软在线视图对接信息 (/ms-view)
     - 直链是否带域名 + 80/443(微软硬性要求)  → ms_ok
     - 页数 / 真实 slide id / 宽高比是否从包里读出来
     - 深链模板 url_tpl 里的 {n} / {id} 占位符(前端翻页靠它换 iframe.src,
       这正是"板书画布随页切换"的服务端那一半)
  3. 公开直链免登录可下载(微软抓取器要能拿到文件), 且支持 HEAD/Range
  4. 批注 PUT/GET 往返(含 v1.27 新增的 ms 段: 板书区域/同步模式/附加板书页)
  5. 白板新建、社区(论坛/聊天)、公告、认证等接口不回 5xx
任何一步失败都会打印 FAIL 并以非 0 退出。
"""
from __future__ import annotations

import io
import json
import os
import shutil
import sys
import tempfile
import time
import zipfile
from pathlib import Path

# ---- 必须在 import server.* 之前设定环境 -------------------------------------
_TMP = tempfile.mkdtemp(prefix="fla-smoke-")
os.environ["FLA_DATA_DIR"] = _TMP
os.environ["ADMIN_PASSWORD"] = "smoke-admin-pw"
os.environ["PUBLIC_BASE_URL"] = "https://class.example.com"   # 部署脚本写进来的对外域名
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import warnings                                    # noqa: E402

warnings.filterwarnings("ignore")

from fastapi.testclient import TestClient          # noqa: E402
from server.main import app                        # noqa: E402

PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(("  ok   " if cond else "  FAIL ") + name + (("  → " + str(extra)) if (extra and not cond) else ""))


def section(t):
    print("\n== " + t + " " + "=" * max(0, 60 - len(t)))


# ---------------------------------------------------------------- 最小 pptx ---
CT = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
</Types>"""

RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>"""


def pres_xml(n=3, cx=12192000, cy=6858000):
    """n 页幻灯片的 presentation.xml, slide id 从 256 递增(与 PowerPoint 一致)"""
    ids = "".join(f'<p:sldId id="{256 + i}" r:id="rId{100 + i}"/>' for i in range(n))
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<p:sldMasterIdLst/>
<p:sldIdLst>{ids}</p:sldIdLst>
<p:sldSz cx="{cx}" cy="{cy}"/>
<p:notesSz cx="{cy}" cy="{cx}"/>
</p:presentation>"""


def make_pptx(n=3) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CT)
        z.writestr("_rels/.rels", RELS)
        z.writestr("ppt/presentation.xml", pres_xml(n))
        for i in range(n):
            z.writestr(f"ppt/slides/slide{i + 1}.xml",
                       '<?xml version="1.0"?><p:sld xmlns:p='
                       '"http://schemas.openxmlformats.org/presentationml/2006/main"/>')
    return buf.getvalue()


def main():
    # with 上下文才会触发 FastAPI 的 startup(建表 / 初始管理员)
    with TestClient(app) as c:
        return run(c)


def run(c):

    section("1. 服务与登录")
    r = c.get("/api/health")
    check("GET /api/health", r.status_code == 200 and r.json().get("ok"), r.text[:120])

    r = c.post("/api/auth/login", json={"username": "admin", "password": "smoke-admin-pw"})
    check("管理员登录", r.status_code == 200 and r.json().get("token"), r.text[:200])
    tok = (r.json() or {}).get("token", "")
    H = {"Authorization": "Bearer " + tok}
    r = c.post("/api/auth/login", json={"username": "admin", "password": "wrong"})
    check("错误密码被拒", r.status_code in (400, 401, 403), r.status_code)

    section("2. 上传 pptx + 微软在线视图对接 (/ms-view)")
    pptx = make_pptx(3)
    r = c.post("/api/files/upload", headers=H,
               files={"file": ("第三章 光合作用.pptx", pptx,
                               "application/vnd.openxmlformats-officedocument.presentationml.presentation")})
    check("上传 pptx", r.status_code == 200 and r.json().get("id"), r.text[:200])
    fid = (r.json() or {}).get("id")
    if not fid:
        return finish()

    r = c.get(f"/api/files/{fid}/meta", headers=H)
    check("GET meta", r.status_code == 200 and r.json().get("kind") == "office", r.text[:200])

    r = c.get(f"/api/files/{fid}/share-link", headers=H)
    sl = r.json() if r.status_code == 200 else {}
    check("GET share-link", bool(sl.get("direct")), r.text[:200])
    check("直链是域名 + 443 (ms_ok)", sl.get("ms_ok") is True, sl.get("direct"))
    check("直链纯 ASCII(微软抓取器不接受中文路径)",
          all(ord(ch) < 128 for ch in (sl.get("path") or "")), sl.get("path"))

    r = c.get(f"/api/files/{fid}/ms-view", headers=H)
    mv = r.json() if r.status_code == 200 else {}
    check("GET /ms-view", r.status_code == 200 and mv.get("provider") == "ms", r.text[:200])
    check("family=ppt", mv.get("family") == "ppt", mv.get("family"))
    check("页数取自 slide id 列表 (=3)", mv.get("pages") == 3, mv.get("pages"))
    check("真实 slide id [256,257,258]", mv.get("slide_ids") == [256, 257, 258], mv.get("slide_ids"))
    check("宽高比 16:9", abs((mv.get("aspect") or 0) - 16 / 9) < 1e-3, mv.get("aspect"))
    check("首页 URL 打到微软 embed.aspx", "view.officeapps.live.com/op/embed.aspx" in (mv.get("url") or ""),
          (mv.get("url") or "")[:160])
    tpl = mv.get("url_tpl") or ""
    check("url_tpl 含 {n} 占位符", "{n}" in tpl, tpl[:160])
    check("url_tpl 含 {id} 占位符", "{id}" in tpl, tpl[:160])
    check("src 只出现一次(翻页不重新转换)", tpl.count("src=") == 1, tpl.count("src="))
    u2 = tpl.replace("{n}", "2").replace("{id}", "257")
    check("第 2 页深链: wdStartOn=2", "wdStartOn=2" in u2, u2[:200])
    check("第 2 页深链: wdSlideId=257", "wdSlideId=257" in u2, u2[:200])
    check("deep_link 允许我方驱动翻页", mv.get("deep_link") is True, mv.get("deep_link"))

    section("3. 公开直链(免登录, 微软抓取器要能拿到)")
    r = c.get(sl.get("path") or "/api/files/share/none.pptx")
    check("免登录下载", r.status_code == 200 and r.content == pptx, r.status_code)
    r = c.head(sl.get("path") or "/api/files/share/none.pptx")
    check("HEAD 探测", r.status_code == 200 and r.headers.get("content-length") == str(len(pptx)), r.status_code)
    r = c.get(sl.get("path") or "/api/files/share/none.pptx", headers={"Range": "bytes=0-9"})
    check("Range 分段(206)", r.status_code in (200, 206), r.status_code)
    r = c.get(f"/api/files/{fid}/ms-view")
    check("未登录访问 ms-view 被拒", r.status_code in (401, 403), r.status_code)

    section("4. 批注往返(含 v1.27 ms 段)")
    ann = {
        "pages": [{"t": "ms", "n": i, "pid": f"m{i}", "bg": "w"} for i in range(3)]
                 + [{"t": "blank", "n": 3, "pid": "x0", "w": 1280, "h": 720}],
        "strokes": {"m1": [{"id": "s1", "tool": "pen", "color": "#ef4444", "width": 4,
                            "pts": [[10, 20], [300, 400]]}],
                    "x0": [{"id": "s2", "tool": "text", "color": "#111827", "width": 30,
                            "pts": [[80, 90]], "text": "板书页"}]},
        "bb": {"1": [{"id": "b1", "tool": "pen", "color": "#fff", "width": 3, "pts": [[1, 2], [3, 4]]}], "n": 2},
        "ms": {"rect": [0.04, 0.09, 0.92, 0.8], "sync": "deep", "extra": 1, "v": 2},
    }
    r = c.put(f"/api/files/{fid}/annotations", headers=H, json=ann)
    check("PUT annotations", r.status_code == 200, r.text[:200])
    r = c.get(f"/api/files/{fid}/annotations", headers=H)
    got = r.json() if r.status_code == 200 else {}
    check("GET annotations", r.status_code == 200, r.text[:200])
    check("笔迹按页存回", (got.get("strokes") or {}).get("m1", [{}])[0].get("tool") == "pen",
          json.dumps(got.get("strokes"), ensure_ascii=False)[:200])
    check("附加板书页笔迹存回", bool((got.get("strokes") or {}).get("x0")), got.get("strokes"))
    check("板中板笔迹存回", bool((got.get("bb") or {}).get("1")), got.get("bb"))
    check("ms 段存回(板书区域/同步模式/附加页)",
          (got.get("ms") or {}).get("sync") == "deep" and len((got.get("ms") or {}).get("rect") or []) == 4
          and (got.get("ms") or {}).get("extra") == 1, got.get("ms"))
    r = c.put(f"/api/files/{fid}/annotations", headers=H, json={"pages": [], "strokes": {"m0": []}})
    check("不带 ms 段也能存(向后兼容)", r.status_code == 200, r.text[:160])
    r = c.get(f"/api/files/{fid}/annotations", headers=H)
    check("ms 段缺省时不报错", r.status_code == 200, r.text[:160])

    section("5. 白板 / 认证 / 社区")
    r = c.post("/api/files/board", headers=H, json={"name": "冒烟白板", "w": 1280, "h": 720})
    check("新建白板", r.status_code == 200 and r.json().get("id"), r.text[:200])

    # 注册需邀请码(管理员发放) — 这也是真实部署流程
    r = c.post("/api/admin/invites", headers=H, json={"code": "SMOKE-2027", "max_uses": 5, "note": "冒烟"})
    check("管理员发放邀请码", r.status_code == 200 and r.json().get("code") == "SMOKE-2027", r.text[:200])
    r = c.post("/api/auth/register", json={"username": "smoke_t1", "password": "pw-smoke-123",
                                           "nickname": "冒烟老师", "invite_code": "SMOKE-2027"})
    check("用邀请码注册教师账号", r.status_code == 200 and r.json().get("token"), r.text[:220])
    r2 = c.post("/api/auth/register", json={"username": "smoke_t2", "password": "pw-smoke-123",
                                            "nickname": "无码", "invite_code": "WRONG-CODE"})
    check("无效邀请码被拒", r2.status_code == 400, r2.status_code)
    sj = r.json() or {}
    sh = {"Authorization": "Bearer " + sj.get("token", "")}
    uid_t = (sj.get("user") or {}).get("id") or sj.get("id")

    r = c.get("/api/files", headers=sh)
    check("学生看不到别人的课件", r.status_code == 200 and all(f["id"] != fid for f in r.json()), r.text[:200])
    r = c.get(f"/api/files/{fid}/ms-view", headers=sh)
    check("越权 ms-view 被拒", r.status_code in (401, 403, 404), r.status_code)

    # 认证(教师 / 站长): 管理员发放, 前端据此渲染徽章
    r = c.get("/api/admin/users", headers=H)
    users = r.json() if r.status_code == 200 else []
    if isinstance(users, dict):
        users = users.get("users") or users.get("items") or []
    trow = next((u for u in users if u.get("username") == "smoke_t1"), None)
    check("管理员能看到用户列表", bool(trow), r.text[:160])
    if trow:
        uid_t = trow["id"]
        r = c.put(f"/api/admin/users/{uid_t}", headers=H, json={
            "is_teacher": True, "cert_title": "特级教师", "cert_icon": "medal", "cert_color": "#f59e0b"})
        check("发放教师认证", r.status_code == 200, r.text[:200])
        r = c.put(f"/api/admin/users/{uid_t}", headers=H, json={"cert_icon": "not-an-icon"})
        check("非法认证图标被拒", r.status_code == 400, r.status_code)
        r = c.put(f"/api/admin/users/{uid_t}", headers=H, json={"cert_color": "red"})
        check("非法认证颜色被拒", r.status_code == 400, r.status_code)
        r = c.get("/api/auth/me", headers=sh)
        me = r.json() if r.status_code == 200 else {}
        u = me.get("user") or me
        check("认证信息回读(称号/图标/颜色)",
              u.get("cert_title") == "特级教师" and u.get("cert_icon") == "medal"
              and u.get("cert_color") == "#f59e0b" and u.get("is_teacher") is True,
              json.dumps(u, ensure_ascii=False)[:220])

    # 站长(管理员)认证
    r = c.get("/api/auth/me", headers=H)
    adm = (r.json() or {}).get("user") or (r.json() or {})
    if adm.get("id"):
        r = c.put(f"/api/admin/users/{adm['id']}", headers=H, json={
            "cert_title": "站长", "cert_icon": "crown", "cert_color": "#a855f7"})
        check("发放站长认证", r.status_code == 200, r.text[:200])

    section("5b. 聊天(微信级): 私聊 / 未读 / 已读回执 / 群管理")
    r = c.get("/api/chat/inbox", headers=H)
    inbox = r.json() if r.status_code == 200 else {}
    check("会话列表 /inbox", r.status_code == 200 and isinstance(inbox.get("items"), list), r.text[:200])
    official = next((x for x in inbox.get("items", []) if x.get("official")), None)
    check("官方大厅自动在列(人人有份)", bool(official) and official.get("joined"), json.dumps(official, ensure_ascii=False)[:200])
    r = c.get("/api/chat/unread", headers=H)
    check("未读汇总 /unread", r.status_code == 200 and "total" in (r.json() or {}), r.text[:160])

    # --- 通讯录(建群/邀请/@ 用) ---
    r = c.get("/api/chat/contacts", headers=H)
    ct = (r.json() or {}).get("items") or []
    check("通讯录 /contacts", r.status_code == 200 and len(ct) >= 2, r.text[:200])
    check("通讯录标出自己", any(x.get("self") for x in ct), json.dumps(ct, ensure_ascii=False)[:160])
    r = c.get("/api/chat/contacts?q=冒烟", headers=H)
    check("通讯录支持搜索", r.status_code == 200 and len((r.json() or {}).get("items") or []) >= 1, r.text[:200])
    r = c.get("/api/chat/contacts")
    check("通讯录需登录", r.status_code == 401, r.status_code)

    # --- 私聊 ---
    r = c.post(f"/api/chat/dm/{uid_t}", headers=H)
    dm = (r.json() or {}).get("id") if r.status_code == 200 else 0
    check("管理员发起私聊", r.status_code == 200 and dm, r.text[:200])
    r = c.post(f"/api/chat/dm/{uid_t}", headers=H)
    check("重复发起复用同一会话(微信行为)", (r.json() or {}).get("id") == dm, r.text[:160])
    r = c.post("/api/chat/dm/1", headers=H)
    check("不能和自己私聊", r.status_code == 400, r.status_code)

    r = c.post(f"/api/chat/rooms/{dm}/messages", headers=H, json={"content": "老师好, 课件收到了"})
    m1 = (r.json() or {}).get("id") if r.status_code == 200 else 0
    check("私聊发言", r.status_code == 200 and m1, r.text[:200])
    it = (r.json() or {}).get("item") or {}
    check("发言回执带完整消息体", it.get("id") == m1 and it.get("mine") is True, json.dumps(it, ensure_ascii=False)[:200])
    r = c.get("/api/chat/unread", headers=sh)
    tu = r.json() or {}
    check("对方未读数 +1", tu.get("total") == 1 and any(x["id"] == dm for x in tu.get("rooms", [])),
          json.dumps(tu, ensure_ascii=False)[:200])
    r = c.get("/api/chat/inbox", headers=sh)
    dmr = next((x for x in (r.json() or {}).get("items", []) if x["id"] == dm), None)
    check("私聊会话显示对方昵称 + 最后一条", bool(dmr) and dmr.get("peer", {}).get("id") == 1
          and "课件" in (dmr.get("last") or {}).get("content", ""), json.dumps(dmr, ensure_ascii=False)[:240])
    r = c.post(f"/api/chat/rooms/{dm}/read", headers=sh, json={})
    check("标记已读", r.status_code == 200, r.text[:160])
    r = c.get(f"/api/chat/rooms/{dm}/messages", headers=H)
    got = (r.json() or {}).get("items") or []
    mine = next((x for x in got if x.get("mine")), None)
    check("私聊已读回执: 1/1 已读", bool(mine) and mine.get("read_count") == 1 and mine.get("read_total") == 1,
          json.dumps(mine, ensure_ascii=False)[:240])
    r = c.get("/api/chat/unread", headers=sh)
    check("已读后未读归零", (r.json() or {}).get("total") == 0, r.text[:160])

    # --- 正在输入 ---
    r = c.post(f"/api/chat/rooms/{dm}/typing", headers=sh)
    check("上报正在输入", r.status_code == 200, r.text[:120])
    r = c.get(f"/api/chat/rooms/{dm}/messages", headers=H)
    check("对方看到「正在输入」", bool((r.json() or {}).get("typing")), json.dumps((r.json() or {}).get("typing"))[:160])

    # --- 群聊 ---
    r = c.post("/api/chat/rooms", headers=sh, json={"name": "未开放前建群"})
    check("未开放建群时普通用户被拒", r.status_code == 403, r.status_code)
    r = c.put("/api/admin/settings", headers=H, json={"allow_group_create": True})
    check("管理员开放建群", r.status_code == 200, r.text[:160])
    r = c.post("/api/chat/rooms", headers=sh, json={"name": "x"})
    check("群名太短被拒", r.status_code == 400, r.status_code)
    time.sleep(0.32)
    r = c.post("/api/chat/rooms", headers=sh, json={"name": "高三(2)班", "intro": "作业与答疑", "members": [1]})
    room = r.json() if r.status_code == 200 else {}
    rid = room.get("id")
    check("教师建群并拉人", r.status_code == 200 and rid, r.text[:220])
    if rid:
        r = c.get(f"/api/chat/rooms/{rid}", headers=sh)
        det = r.json() if r.status_code == 200 else {}
        check("群资料: 成员/群主/公告", det.get("members") == 2 and det.get("i_am_owner") is True
              and det.get("intro") == "作业与答疑", json.dumps(det, ensure_ascii=False)[:240])
        r = c.post(f"/api/chat/rooms/{rid}/messages", headers=sh,
                   json={"content": "@管理员 请查收第三页板书", "mentions": [1]})
        gm = (r.json() or {}).get("id") if r.status_code == 200 else 0
        check("群内发言 + @某人", r.status_code == 200 and gm, r.text[:220])
        r = c.get("/api/chat/inbox", headers=H)
        gr = next((x for x in (r.json() or {}).get("items", []) if x["id"] == rid), None)
        check("被 @ 的人收到 at_me 提醒", bool(gr) and gr.get("at_me") == 1 and gr.get("unread") >= 1,
              json.dumps(gr, ensure_ascii=False)[:240])
        time.sleep(0.32)
        r = c.post(f"/api/chat/rooms/{rid}/messages", headers=H,
                   json={"content": "引用一下", "reply_to": gm})
        rm = (r.json() or {}).get("item") or {}
        check("引用回复带原文摘要", (rm.get("reply") or {}).get("id") == gm
              and "第三页" in (rm.get("reply") or {}).get("content", ""), json.dumps(rm, ensure_ascii=False)[:240])
        r = c.post(f"/api/chat/messages/{gm}/react", headers=H, json={"emoji": "👍"})
        check("表情回应", r.status_code == 200 and any(x["emoji"] == "👍" for x in (r.json() or {}).get("reacts", [])),
              r.text[:200])
        r = c.post(f"/api/chat/messages/{gm}/react", headers=H, json={"emoji": "👍"})
        check("再点一次取消回应", r.status_code == 200 and not (r.json() or {}).get("reacts"), r.text[:200])
        r = c.post(f"/api/chat/messages/{gm}/react", headers=H, json={"emoji": "💩"})
        check("非白名单表情被拒", r.status_code == 400, r.status_code)
        r = c.patch(f"/api/chat/messages/{gm}", headers=sh, json={"content": "改过的内容"})
        check("编辑自己的消息", r.status_code == 200, r.text[:160])
        # 第三名普通成员(非群主非管理员): 用来验证越权被拒
        r = c.post("/api/auth/register", json={"username": "smoke_t3", "password": "pw-smoke-123",
                                               "nickname": "冒烟学生", "invite_code": "SMOKE-2027"})
        s3 = {"Authorization": "Bearer " + (r.json() or {}).get("token", "")}
        uid_3 = ((r.json() or {}).get("user") or {}).get("id")
        check("注册第三名成员", r.status_code == 200 and uid_3, r.text[:200])
        r = c.post(f"/api/chat/rooms/{rid}/invite", headers=sh, json={"uids": [uid_3]})
        check("群主邀请第三名成员", r.status_code == 200, r.text[:160])
        r = c.patch(f"/api/chat/messages/{gm}", headers=s3, json={"content": "路人想改"})
        check("非作者不能编辑别人的消息", r.status_code == 403, r.status_code)
        r = c.delete(f"/api/chat/messages/{gm}", headers=s3)
        check("非作者不能撤回别人的消息", r.status_code == 403, r.status_code)
        r = c.patch(f"/api/chat/messages/{gm}", headers=H, json={"content": "管理员代为修订"})
        check("管理员可代管任意消息", r.status_code == 200, r.text[:160])
        r = c.get(f"/api/chat/rooms/{rid}/messages", headers=s3)
        ed = next((x for x in ((r.json() or {}).get("items") or []) if x["id"] == gm), None)
        check("代管消息标出 edited_by_admin", bool(ed) and ed.get("edited_by_admin") is True,
              json.dumps(ed, ensure_ascii=False)[:200])
        r = c.delete(f"/api/chat/messages/{gm}", headers=sh)
        check("作者 2 分钟内可撤回", r.status_code == 200, r.text[:160])
        r = c.get(f"/api/chat/rooms/{rid}/messages", headers=H)
        items = (r.json() or {}).get("items") or []
        rec = next((x for x in items if x["id"] == gm), None)
        check("撤回后内容为空且标 deleted", bool(rec) and rec.get("deleted") and rec.get("content") == "",
              json.dumps(rec, ensure_ascii=False)[:200])
        # 免打扰 / 置顶 / 群昵称
        r = c.patch(f"/api/chat/rooms/{rid}/me", headers=H,
                    json={"muted": True, "pinned": True, "nickname": "教务主任"})
        mo = (r.json() or {}).get("room") or {}
        check("免打扰 + 置顶 + 群昵称", mo.get("muted") is True and mo.get("pinned") is True
              and mo.get("my_nickname") == "教务主任", json.dumps(mo, ensure_ascii=False)[:220])
        r = c.post(f"/api/chat/rooms/{rid}/messages", headers=sh, json={"content": "第二条"})
        r = c.get("/api/chat/unread", headers=H)
        uu = r.json() or {}
        check("免打扰的会话不计入数字红点(只计 dot)", uu.get("total") == 0 and uu.get("dot") >= 1,
              json.dumps(uu, ensure_ascii=False)[:200])
        r = c.get("/api/chat/inbox", headers=H)
        check("置顶会话排在最前", ((r.json() or {}).get("items") or [{}])[0].get("id") == rid,
              json.dumps((r.json() or {}).get("items") or [], ensure_ascii=False)[:200])
        # 群管理
        r = c.patch(f"/api/chat/rooms/{rid}", headers=s3, json={"name": "路人改名"})
        check("普通成员不能改群资料", r.status_code == 403, r.status_code)
        r = c.post(f"/api/chat/rooms/{rid}/kick", headers=s3, json={"uid": 1})
        check("普通成员不能踢人", r.status_code == 403, r.status_code)
        r = c.patch(f"/api/chat/rooms/{rid}", headers=sh, json={"name": "高三(2)班·物理", "intro": "新公告"})
        check("群主改群名/公告", r.status_code == 200, r.text[:200])
        r = c.post(f"/api/chat/rooms/{rid}/kick", headers=sh, json={"uid": uid_3})
        check("群主移出成员", r.status_code == 200, r.text[:200])
        r = c.get(f"/api/chat/rooms/{rid}", headers=s3)
        check("被移出后看不到群", r.status_code == 403, r.status_code)
        r = c.post(f"/api/chat/rooms/{rid}/messages", headers=s3, json={"content": "我还能说话吗"})
        check("被移出后不能发言", r.status_code == 403, r.status_code)
        r = c.post(f"/api/chat/rooms/{rid}/invite", headers=sh, json={"uids": [uid_3]})
        check("重新邀请入群", r.status_code == 200 and (r.json() or {}).get("added"), r.text[:200])
        r = c.post(f"/api/chat/rooms/{rid}/transfer", headers=s3, json={"uid": 1})
        check("非群主不能转让", r.status_code == 403, r.status_code)
        r = c.post(f"/api/chat/rooms/{rid}/transfer", headers=sh, json={"uid": 1})
        check("转让群主", r.status_code == 200, r.text[:200])
        r = c.get(f"/api/chat/rooms/{rid}", headers=H)
        check("新群主资料正确", (r.json() or {}).get("i_am_owner") is True, r.text[:200])
        r = c.post(f"/api/chat/rooms/{rid}/leave", headers=sh)
        check("原群主(已转让)可退群", r.status_code == 200, r.text[:200])
        # 历史分页 + 搜索
        for i in range(5):
            time.sleep(0.32)          # 服务端有 0.3 秒防刷节流
            c.post(f"/api/chat/rooms/{rid}/messages", headers=H, json={"content": f"历史消息 {i}"})
        r = c.get(f"/api/chat/rooms/{rid}/messages?limit=3", headers=H)
        page = (r.json() or {}).get("items") or []
        check("按 limit 取最近消息", len(page) == 3, len(page))
        r = c.get(f"/api/chat/rooms/{rid}/messages?before={page[0]['id']}&limit=3", headers=H)
        older = (r.json() or {}).get("items") or []
        check("向上翻历史(before)", bool(older) and all(x["id"] < page[0]["id"] for x in older),
              json.dumps([x["id"] for x in older])[:160])
        r = c.get(f"/api/chat/rooms/{rid}/messages?after={page[-1]['id']}", headers=H)
        check("增量拉新(after)", r.status_code == 200, r.text[:160])
        r = c.get("/api/chat/search?q=历史消息", headers=H)
        hits = (r.json() or {}).get("items") or []
        check("全文搜索聊天记录", len(hits) >= 5 and all("历史消息" in x["content"] for x in hits),
              json.dumps(hits, ensure_ascii=False)[:200])
        r = c.post(f"/api/chat/rooms/{rid}/leave", headers=s3)
        check("普通成员可退群", r.status_code == 200, r.text[:160])
        r = c.get("/api/chat/search?q=历史消息", headers=s3)
        check("退群后搜不到该群记录", r.status_code == 200 and not (r.json() or {}).get("items"),
              json.dumps((r.json() or {}).get("items"), ensure_ascii=False)[:160])

    section("5c. 聊天附件: 图片 / 语音 / 文件")
    png = (b"\x89PNG\r\n\x1a\n" + b"0" * 64)
    r = c.post("/api/chat/attachments", headers=H, files={"file": ("板书.png", png, "image/png")},
               data={"kind": "image"})
    aid = (r.json() or {}).get("id") if r.status_code == 200 else 0
    check("上传图片附件", r.status_code == 200 and aid, r.text[:220])
    r = c.post("/api/chat/attachments", headers=H, files={"file": ("病毒.exe", b"MZ", "application/x-msdownload")},
               data={"kind": "file"})
    check("拒绝危险扩展名", r.status_code == 400, r.status_code)
    r = c.post("/api/chat/attachments", headers=H, files={"file": ("语音.webm", b"1a45dfa3" * 8, "audio/webm")},
               data={"kind": "audio", "dur_ms": "3200"})
    vid = (r.json() or {}).get("id") if r.status_code == 200 else 0
    check("上传语音附件(带时长)", r.status_code == 200 and (r.json() or {}).get("dur_ms") == 3200, r.text[:220])
    if dm and aid:
        r = c.post(f"/api/chat/rooms/{dm}/messages", headers=H, json={"kind": "image", "att_id": aid})
        im = (r.json() or {}).get("item") or {}
        check("发送图片消息", r.status_code == 200 and (im.get("att") or {}).get("kind") == "image",
              json.dumps(im, ensure_ascii=False)[:240])
        r = c.get((im.get("att") or {}).get("url") or "/api/chat/attachments/0", headers=sh)
        check("对方可取图片(inline)", r.status_code == 200 and r.content == png, r.status_code)
        r = c.get((im.get("att") or {}).get("url") or "/api/chat/attachments/0")
        check("未登录取附件被拒", r.status_code in (401, 403), r.status_code)
    if dm and vid:
        r = c.post(f"/api/chat/rooms/{dm}/messages", headers=H, json={"kind": "audio", "att_id": vid})
        check("发送语音消息", r.status_code == 200, r.text[:200])
    r = c.post(f"/api/chat/rooms/{dm}/messages", headers=H, json={"kind": "image", "att_id": 999999})
    check("不存在的附件被拒", r.status_code == 404, r.status_code)

    section("5d. 权限与开关")
    r = c.put("/api/admin/users/" + str(uid_t), headers=H, json={"chat_banned": True})
    check("管理员禁言", r.status_code == 200, r.text[:160])
    r = c.post(f"/api/chat/rooms/{dm}/messages", headers=sh, json={"content": "我还能说话吗"})
    check("被禁言者不能发言", r.status_code == 403, r.status_code)
    r = c.put("/api/admin/users/" + str(uid_t), headers=H, json={"chat_banned": False})
    check("解除禁言", r.status_code == 200, r.text[:160])
    r = c.put("/api/admin/settings", headers=H, json={"chat_enabled": False})
    check("关闭聊天区", r.status_code == 200, r.text[:160])
    r = c.post(f"/api/chat/rooms/{dm}/messages", headers=sh, json={"content": "还在吗"})
    check("关闭后普通用户不能发言", r.status_code == 403, r.status_code)
    time.sleep(0.32)
    r = c.post(f"/api/chat/rooms/{dm}/messages", headers=H, json={"content": "管理员仍可发言"})
    check("关闭后管理员仍可发言", r.status_code == 200, r.text[:160])
    r = c.put("/api/admin/settings", headers=H, json={"chat_enabled": True})
    check("重新开启聊天区", r.status_code == 200, r.text[:160])
    r = c.get(f"/api/chat/rooms/{dm}/messages", headers=sh)
    check("成员可读消息", r.status_code == 200, r.text[:160])

    for path, label in [("/api/forum/threads", "论坛帖子列表"),
                        ("/api/forum/boards", "论坛板块"),
                        ("/api/announcements", "公告列表"),
                        ("/api/auth/config", "前端配置")]:
        rr = c.get(path, headers=H)
        check(label + " 不回 5xx", rr.status_code < 500, f"{rr.status_code} {rr.text[:120]}")

    r = c.get("/api/admin/stats", headers=H)
    check("管理后台统计", r.status_code < 500, r.status_code)
    r = c.get("/api/admin/settings", headers=H)
    check("系统设置可读", r.status_code < 500, r.status_code)

    section("5e. 其余接口补测: 资料 / 头像 / 改密 / 扫码登录 / 公告 / 论坛 / 邀请码 / 文件直读")
    PNG = b"\x89PNG\r\n\x1a\n" + b"fla-smoke-avatar-bytes"

    # --- 个人资料 ---
    r = c.put("/api/users/profile", headers=sh, json={"nickname": "冒烟老师(改)", "signature": "认真上课"})
    check("PUT /api/users/profile", r.status_code == 200 and (r.json() or {}).get("nickname") == "冒烟老师(改)",
          r.text[:200])
    r = c.put("/api/users/profile", headers=sh, json={"nickname": "  "})
    check("空昵称被拒", r.status_code == 400, r.status_code)
    r = c.put("/api/users/profile", headers=sh, json={"signature": "长" * 201})
    check("超长签名被拒", r.status_code == 400, r.status_code)

    # --- 头像: 自己传 + 管理员代传 + 静态取回 ---
    r = c.post("/api/users/avatar", headers=sh, files={"file": ("a.png", PNG, "image/png")})
    av = (r.json() or {}).get("avatar", "") if r.status_code == 200 else ""
    check("POST /api/users/avatar", r.status_code == 200 and av.startswith("/api/avatars/"), r.text[:200])
    r = c.get(av or "/api/avatars/none.png")
    check("GET /api/avatars/{name} 取回原图", r.status_code == 200 and r.content == PNG, r.status_code)
    r = c.post("/api/users/avatar", headers=sh, files={"file": ("a.exe", b"MZ\x90", "application/octet-stream")})
    check("非图片头像被拒", r.status_code == 400, r.status_code)
    r = c.post(f"/api/admin/users/{uid_t}/avatar", headers=H, files={"file": ("b.png", PNG, "image/png")})
    check("管理员代传头像", r.status_code == 200 and (r.json() or {}).get("avatar"), r.text[:200])

    # --- 改密码 ---
    r = c.post("/api/auth/change_password", headers=sh,
               json={"old_password": "pw-smoke-123", "new_password": "pw-smoke-456"})
    check("POST /api/auth/change_password", r.status_code == 200, r.text[:200])
    r = c.post("/api/auth/change_password", headers=sh,
               json={"old_password": "不对", "new_password": "pw-smoke-789"})
    check("原密码错误被拒", r.status_code == 400, r.status_code)
    r = c.post("/api/auth/change_password", headers=sh, json={"old_password": "pw-smoke-456", "new_password": "123"})
    check("新密码太短被拒", r.status_code == 400, r.status_code)
    r = c.post("/api/auth/login", json={"username": "smoke_t1", "password": "pw-smoke-456"})
    check("改密后新密码可登录", r.status_code == 200 and (r.json() or {}).get("token"), r.text[:200])

    # --- 扫码登录全链路(票据 → 已登录设备批准 → 取 token → 一次作废) ---
    r = c.post("/api/auth/qr/ticket")
    tk = (r.json() or {}).get("ticket", "")
    check("POST /api/auth/qr/ticket", r.status_code == 200 and tk.startswith("qr"), r.text[:200])
    r = c.get("/api/auth/qr/status", params={"ticket": tk})
    check("未批准时 status=pending", (r.json() or {}).get("status") == "pending", r.text[:160])
    r = c.post("/api/auth/qr/approve", headers=sh, json={"ticket": tk})
    check("POST /api/auth/qr/approve", r.status_code == 200, r.text[:200])
    r = c.get("/api/auth/qr/status", params={"ticket": tk})
    qs = r.json() if r.status_code == 200 else {}
    check("批准后拿到 token + 用户信息", qs.get("status") == "ok" and bool(qs.get("token")) and qs.get("user"),
          r.text[:200])
    if qs.get("token"):
        rr = c.get("/api/auth/me", headers={"Authorization": "Bearer " + qs["token"]})
        check("扫码换来的 token 可用", rr.status_code == 200, rr.status_code)
    r = c.get("/api/auth/qr/status", params={"ticket": tk})
    check("票据一次作废(第二次取不到 token)", (r.json() or {}).get("status") != "ok", r.text[:160])
    r = c.get("/api/auth/qr/status", params={"ticket": "qr-不存在"})
    check("无效票据 → invalid", (r.json() or {}).get("status") == "invalid", r.text[:160])
    r = c.post("/api/auth/qr/approve", headers=sh, json={"ticket": "qr-不存在"})
    check("批准不存在的票据被拒(404)", r.status_code == 404, r.status_code)

    # --- 公告: 管理端 CRUD + 用户端读取/已读 ---
    r = c.post("/api/admin/announcements", headers=H,
               json={"title": "期中考试安排", "content": "周五下午两点", "level": "imp"})
    aid_g = (r.json() or {}).get("id")
    check("POST /api/admin/announcements(全局)", r.status_code == 200 and aid_g, r.text[:200])
    r = c.post("/api/admin/announcements", headers=H,
               json={"title": "给你的专属通知", "content": "补交作业", "level": "warn",
                     "scope": "user", "target_uid": uid_t})
    aid_u = (r.json() or {}).get("id")
    check("定向公告(指定用户)", r.status_code == 200 and aid_u, r.text[:200])
    r = c.post("/api/admin/announcements", headers=H, json={"title": "短"})
    check("公告标题太短被拒", r.status_code == 400, r.status_code)
    r = c.post("/api/admin/announcements", headers=H, json={"title": "级别非法", "level": "urgent"})
    check("公告级别非法被拒", r.status_code == 400, r.status_code)
    r = c.post("/api/admin/announcements", headers=H, json={"title": "定向没选人", "scope": "user"})
    check("定向公告缺 target_uid 被拒", r.status_code == 400, r.status_code)
    r = c.post("/api/admin/announcements", headers=sh, json={"title": "学生想发公告"})
    check("非管理员发公告被拒", r.status_code in (401, 403), r.status_code)

    r = c.get("/api/admin/announcements", headers=H)
    al = r.json() if r.status_code == 200 else []
    check("GET /api/admin/announcements", r.status_code == 200 and isinstance(al, list) and len(al) >= 2,
          r.text[:160])
    r = c.get("/api/announcements", headers=sh)
    ann = r.json() if r.status_code == 200 else {}
    ids = [x.get("id") for x in ann.get("items", [])]
    check("用户端收到全局 + 专属公告", aid_g in ids and aid_u in ids, ids)
    check("专属公告带 personal 标记",
          any(x.get("id") == aid_u and x.get("personal") is True for x in ann.get("items", [])), "")
    check("未读数与 items 一致",
          ann.get("unread") == sum(1 for x in ann.get("items", []) if not x.get("read")), ann.get("unread"))
    r = c.get("/api/announcements", headers=s3)
    check("别人收不到定向公告", aid_u not in [x.get("id") for x in (r.json() or {}).get("items", [])], "")
    r = c.post("/api/announcements/read", headers=sh, json={"ids": [aid_g, aid_u]})
    check("POST /api/announcements/read", r.status_code == 200, r.text[:160])
    r = c.get("/api/announcements", headers=sh)
    check("上报已读后 unread 归零", (r.json() or {}).get("unread") == 0, (r.json() or {}).get("unread"))
    r = c.patch(f"/api/admin/announcements/{aid_g}", headers=H,
                json={"title": "期中考试安排(顺延)", "content": "下周五", "level": "warn",
                      "scope": "global", "active": False})
    check("PATCH 公告(改标题 + 停用)", r.status_code == 200, r.text[:200])
    r = c.get("/api/announcements", headers=sh)
    check("停用后用户端不再看到", aid_g not in [x.get("id") for x in (r.json() or {}).get("items", [])], "")
    r = c.delete(f"/api/admin/announcements/{aid_u}", headers=sh)
    check("非管理员删公告被拒", r.status_code in (401, 403), r.status_code)
    r = c.delete(f"/api/admin/announcements/{aid_u}", headers=H)
    check("DELETE /api/admin/announcements/{aid}", r.status_code == 200, r.text[:160])

    # --- 论坛: 板块 CRUD + 发帖/回复/编辑/锁定/删除 ---
    r = c.post("/api/admin/forum/boards", headers=H, json={"name": "冒烟板块", "descr": "临时用", "sort": 9})
    bid = (r.json() or {}).get("id")
    check("POST /api/admin/forum/boards", r.status_code == 200 and bid, r.text[:200])
    r = c.post("/api/admin/forum/boards", headers=H, json={"name": "短"})
    check("板块名太短被拒", r.status_code == 400, r.status_code)
    r = c.get("/api/forum/boards", headers=sh)
    boards = (r.json() or {}).get("items", [])
    check("GET /api/forum/boards", r.status_code == 200 and any(b.get("id") == bid for b in boards), r.text[:200])
    r = c.get("/api/forum/boards")
    check("未登录看板块被拒", r.status_code in (401, 403), r.status_code)

    r = c.post("/api/forum/threads", headers=sh, json={"board_id": bid, "title": "第一帖", "content": "正文内容"})
    tid = (r.json() or {}).get("id")
    check("POST /api/forum/threads", r.status_code == 200 and tid, r.text[:200])
    r = c.post("/api/forum/threads", headers=sh, json={"board_id": bid, "title": "", "content": "无标题"})
    check("空标题发帖被拒", r.status_code == 400, r.status_code)
    r = c.get("/api/forum/threads", headers=sh, params={"board": bid})
    check("GET /api/forum/threads?board=",
          r.status_code == 200 and any(t.get("id") == tid for t in (r.json() or {}).get("items", [])), r.text[:200])
    r = c.get(f"/api/forum/threads/{tid}", headers=sh)
    det = r.json() if r.status_code == 200 else {}
    check("GET /api/forum/threads/{tid}", r.status_code == 200 and det.get("title") == "第一帖", r.text[:200])
    r = c.post(f"/api/forum/threads/{tid}/posts", headers=s3, json={"content": "路人回复"})
    check("POST /api/forum/threads/{tid}/posts", r.status_code == 200, r.text[:200])
    r = c.post(f"/api/forum/threads/{tid}/posts", headers=s3, json={"content": "   "})
    check("空回复被拒", r.status_code == 400, r.status_code)
    r = c.get(f"/api/forum/threads/{tid}", headers=sh)
    posts = (r.json() or {}).get("posts", [])
    pid = posts[-1].get("id") if posts else None
    check("回复进了帖子(带回复数)", bool(pid) and (r.json() or {}).get("total") == 1, len(posts))
    r = c.patch(f"/api/forum/posts/{pid}", headers=s3, json={"content": "改过的回复"})
    check("PATCH /api/forum/posts/{pid}(作者可改)", r.status_code == 200, r.text[:200])
    r = c.patch(f"/api/forum/posts/{pid}", headers=sh, json={"content": "别人想改"})
    check("非作者改回复被拒", r.status_code in (401, 403), r.status_code)
    r = c.get(f"/api/forum/threads/{tid}", headers=sh)
    check("改过的回复带 edited 标记", (r.json() or {}).get("posts", [{}])[0].get("edited") is True, "")
    r = c.patch(f"/api/forum/threads/{tid}", headers=sh, json={"title": "第一帖(作者改过)"})
    check("PATCH /api/forum/threads/{tid}(作者改标题)", r.status_code == 200, r.text[:200])
    r = c.patch(f"/api/forum/threads/{tid}", headers=sh, json={"pinned": True})
    check("非管理员置顶被拒", r.status_code == 403, r.status_code)
    r = c.patch(f"/api/forum/threads/{tid}", headers=H, json={"pinned": True, "locked": True})
    check("管理员置顶 + 锁定", r.status_code == 200, r.text[:200])
    r = c.get(f"/api/forum/threads/{tid}", headers=sh)
    dd = r.json() or {}
    check("置顶/锁定已生效", dd.get("pinned") is True and dd.get("locked") is True, dd)
    r = c.post(f"/api/forum/threads/{tid}/posts", headers=s3, json={"content": "锁了还想回复"})
    check("锁定帖普通用户回复被拒", r.status_code == 403, r.status_code)
    r = c.post(f"/api/forum/threads/{tid}/posts", headers=H, json={"content": "管理员可回复锁定帖"})
    check("管理员可回复锁定帖", r.status_code == 200, r.text[:200])
    r = c.delete(f"/api/forum/posts/{pid}", headers=s3)
    check("DELETE /api/forum/posts/{pid}(作者可删)", r.status_code == 200, r.text[:200])
    r = c.delete(f"/api/forum/threads/{tid}", headers=s3)
    check("非作者删帖被拒", r.status_code == 403, r.status_code)
    r = c.delete(f"/api/forum/threads/{tid}", headers=sh)
    check("DELETE /api/forum/threads/{tid}(作者可删)", r.status_code == 200, r.text[:200])
    r = c.get(f"/api/forum/threads/{tid}", headers=sh)
    check("删掉的帖子取不到(404)", r.status_code == 404, r.status_code)
    r = c.patch(f"/api/admin/forum/boards/{bid}", headers=H, json={"name": "冒烟板块(改名)", "descr": "", "sort": 1})
    check("PATCH /api/admin/forum/boards/{bid}", r.status_code == 200, r.text[:200])
    r = c.delete(f"/api/admin/forum/boards/{bid}", headers=H)
    check("DELETE /api/admin/forum/boards/{bid}", r.status_code == 200, r.text[:200])
    r = c.delete(f"/api/admin/forum/boards/{bid}", headers=H)
    check("重复删板块 → 404", r.status_code == 404, r.status_code)

    # --- 邀请码: 批量生成 / 列表 / 删除 ---
    r = c.post("/api/admin/invites/batch", headers=H,
               json={"count": 3, "max_uses": 2, "prefix": "SMK", "note": "批量"})
    items = (r.json() or {}).get("items", [])
    check("POST /api/admin/invites/batch",
          r.status_code == 200 and len(items) == 3 and all(i.get("code", "").startswith("SMK-") for i in items),
          r.text[:200])
    r = c.post("/api/admin/invites/batch", headers=H, json={"count": 0})
    check("批量数量非法被拒", r.status_code == 400, r.status_code)
    r = c.post("/api/admin/invites/batch", headers=H, json={"count": 2, "prefix": "小写前缀"})
    check("非法前缀被拒", r.status_code == 400, r.status_code)
    r = c.get("/api/admin/invites", headers=H)
    il = r.json() if r.status_code == 200 else []
    iid = next((x.get("id") for x in il if str(x.get("code", "")).startswith("SMK-")), None)
    check("GET /api/admin/invites", r.status_code == 200 and isinstance(il, list) and bool(iid), r.text[:160])
    check("邀请码状态字段正确", any(x.get("status") == "active" for x in il), "")
    r = c.get("/api/admin/invites", headers=sh)
    check("非管理员看邀请码被拒", r.status_code in (401, 403), r.status_code)
    r = c.delete(f"/api/admin/invites/{iid}", headers=H)
    check("DELETE /api/admin/invites/{iid}", r.status_code == 200, r.text[:200])

    # --- 管理端: 看某人的文件 / 重置密码 ---
    r = c.get(f"/api/admin/users/{uid_t}/files", headers=H)
    check("GET /api/admin/users/{uid}/files", r.status_code == 200 and isinstance(r.json(), list), r.text[:200])
    r = c.get(f"/api/admin/users/{uid_t}/files", headers=sh)
    check("非管理员查他人文件被拒", r.status_code in (401, 403), r.status_code)
    r = c.post(f"/api/admin/users/{uid_t}/reset_password", headers=H)
    npw = (r.json() or {}).get("password", "")
    check("POST /api/admin/users/{uid}/reset_password", r.status_code == 200 and npw.startswith("YJT"), r.text[:200])
    r = c.post("/api/auth/login", json={"username": "smoke_t1", "password": npw})
    check("重置后的新密码可登录", r.status_code == 200 and (r.json() or {}).get("token"), r.text[:200])
    r = c.post(f"/api/admin/users/{uid_t}/reset_password", headers=sh)
    check("非管理员重置他人密码被拒", r.status_code in (401, 403), r.status_code)

    # --- 文件直读: 原文件 / 下载 / 转换产物优雅降级 ---
    r = c.get(f"/api/files/{fid}/raw", headers=H)
    check("GET /api/files/{fid}/raw 返回原文件", r.status_code == 200 and r.content == pptx, r.status_code)
    r = c.get(f"/api/files/{fid}/download", headers=H)
    check("GET /api/files/{fid}/download 带 attachment 头",
          r.status_code == 200 and "attachment" in (r.headers.get("content-disposition") or ""),
          r.headers.get("content-disposition"))
    r = c.get(f"/api/files/{fid}/raw", headers=s3)
    check("越权读原文件被拒", r.status_code in (401, 403, 404), r.status_code)
    r = c.get(f"/api/files/{fid}/pdf", headers=H)
    check("GET /pdf 未转换完成时优雅返回(409 而非 5xx)", r.status_code in (200, 409), r.status_code)
    for ep in ("anim", "bgpdf", "anim-media/none.png", "onlyoffice/verify"):
        rr = c.get(f"/api/files/{fid}/{ep}", headers=H)
        check(f"GET /{ep} 不炸 5xx", rr.status_code < 500, f"{rr.status_code} {rr.text[:100]}")
    # OnlyOffice 未部署时 config 就是应当明确报 503(前端据此提示"未启用"), 不是崩溃
    rr = c.get(f"/api/files/{fid}/onlyoffice/config", headers=H)
    check("GET /onlyoffice/config 未启用 DS 时明确 503(带中文说明)",
          rr.status_code == 503 and "OnlyOffice" in rr.text, f"{rr.status_code} {rr.text[:100]}")
    r = c.get(f"/api/files/{fid}/onlyoffice/verify", headers=H)
    check("未启用 OnlyOffice 时 verify 明确返回 ok=false",
          r.status_code == 200 and (r.json() or {}).get("ok") is False, r.text[:160])
    r = c.post(f"/api/files/{fid}/retry", headers=H)
    check("POST /api/files/{fid}/retry 重新排队",
          r.status_code == 200 and (r.json() or {}).get("status") in ("converting", "ready", "failed"), r.text[:200])
    r = c.post(f"/api/files/{fid}/retry", headers=s3)
    check("越权重试转换被拒", r.status_code in (401, 403, 404), r.status_code)

    # --- 官方大厅: 普通用户主动 join(幂等) ---
    if official and official.get("id"):
        r = c.post(f"/api/chat/rooms/{official['id']}/join", headers=s3)
        check("POST /api/chat/rooms/{rid}/join(官方大厅)", r.status_code == 200, r.text[:200])
        r = c.post(f"/api/chat/rooms/{official['id']}/leave", headers=s3)
        check("官方大厅不允许退群", r.status_code in (400, 403), r.status_code)

    section("6. 前端资源")
    r = c.get("/")
    check("首页引入 msstage.js", r.status_code == 200 and "msstage.js" in r.text, r.status_code)
    r = c.get("/js/msstage.js")
    check("msstage.js 已发布", r.status_code == 200 and "MSStage" in r.text, r.status_code)
    r = c.get("/js/viewer.js")
    check("viewer.js 委托 MSStage", r.status_code == 200 and "MSStage.mount" in r.text, r.status_code)
    r = c.get("/js/present.js")
    check("present.js 委托 MSStage", r.status_code == 200 and "MSStage.mount" in r.text, r.status_code)
    r = c.get("/style.css")
    check("ms-stage 样式已发布", r.status_code == 200 and ".ms-stage" in r.text and ".ms-pill" in r.text,
          r.status_code)
    r = c.get("/present.html")
    check("放映页引入 msstage.js", r.status_code == 200 and "msstage.js" in r.text, r.status_code)
    r = c.get("/js/chat.js")
    check("chat.js 已发布(微信级聊天)", r.status_code == 200 and "window.Chat" in r.text, r.status_code)
    r = c.get("/js/app.js")
    check("app.js 把 #/chat 交给 Chat.view()", r.status_code == 200 and "Chat.view()" in r.text, r.text[:120])
    check("app.js 导航栏有未读角标", "chat-badge" in r.text, "")
    r = c.get("/js/ui.js")
    check("ui.js 补齐聊天图标(mic/smile/at…)", r.status_code == 200 and "mic:" in r.text and "smile:" in r.text,
          r.status_code)
    r = c.get("/style.css")
    check("聊天样式已发布", r.status_code == 200 and ".wx-item" in r.text and ".wx-bubble" in r.text, r.status_code)

    section("6b. 认证证书(v1.27 升级)")
    r = c.get("/js/app.js")
    a = r.text if r.status_code == 200 else ""
    check("证书等级算法 certTier", "function certTier(" in a, "")
    check("证书校验码 certCode(FNV-1a)", "function certCode(" in a and "0x811c9dc5" in a, "")
    check("证书交互 bindCertCards(3D/二维码/大图/打印)", "function bindCertCards(" in a and "certZoom" in a
          and "certPrint" in a, "")
    check("证书要素(编号/签发日期/授权范围/校验码)", all(k in a for k in ("证书编号", "签发日期", "校验码")), "")
    r = c.get("/js/admin.js")
    check("后台改认证时实时预览证书", r.status_code == 200 and "euprev" in r.text and "paintPrev" in r.text,
          r.status_code)
    r = c.get("/style.css")
    css = r.text if r.status_code == 200 else ""
    check("全息箔 / 雕刻底纹 / 光束样式", all(k in css for k in (".cc-holo", ".cc-guilloche", ".cc-beam")), "")
    check("证书打印样式(@media print 只印证书)", "@media print" in css and ".cc-print" in css, "")
    check("证书大图弹层样式", ".cc-zoom" in css and ".cc-big" in css, "")
    check("尊重 prefers-reduced-motion", css.count("prefers-reduced-motion") >= 3, css.count("prefers-reduced-motion"))

    section("7. 删除与清理")
    r = c.delete(f"/api/files/{fid}", headers=H)
    check("删除课件", r.status_code == 200, r.text[:160])
    r = c.get(f"/api/files/{fid}/ms-view", headers=H)
    check("删除后 ms-view 404", r.status_code == 404, r.status_code)

    return finish()


def finish():
    print("\n" + "=" * 66)
    print(f"通过 {len(PASS)} 项, 失败 {len(FAIL)} 项")
    if FAIL:
        for f in FAIL:
            print("  ✗ " + f)
    print("=" * 66)
    shutil.rmtree(_TMP, ignore_errors=True)
    code = 1 if FAIL else 0
    sys.stdout.flush()      # os._exit 不会冲刷缓冲, 必须先 flush
    os._exit(code)          # 转换线程是常驻线程, 直接退出进程


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:                                        # noqa: BLE001
        import traceback
        traceback.print_exc()
        print("\n冒烟测试异常中断:", e)
        shutil.rmtree(_TMP, ignore_errors=True)
        sys.stdout.flush()
        os._exit(2)
