"""手机投屏 / 手机观看
- 电脑 → 手机: 定时截屏 (含批注) 压成 JPEG 上传到 /api/remote/{sid}/frame/pc, 手机 cast.html 实时观看
- 手机 → 电脑: 手机打开摄像头/照片, 上传到 frame/phone, 电脑全屏显示 (可继续用批注工具)
- 手机批注: 手机端画笔/荧光/激光/橡皮/翻页 通过 /action 发来, 电脑画布同步绘制
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
import urllib.parse
import urllib.request

from PyQt5.QtCore import QBuffer, QByteArray, QIODevice, QObject, Qt, QTimer, pyqtSignal
from PyQt5.QtGui import QColor, QImage, QPainter, QPixmap
from PyQt5.QtWidgets import QApplication, QHBoxLayout, QLabel, QVBoxLayout, QWidget
from qfluentwidgets import FluentIcon as FIF
from qfluentwidgets import (BodyLabel, CaptionLabel, PrimaryPushButton, PushButton, SubtitleLabel,
                            TransparentToolButton)

from . import core
from .core import cfg
from .stage import _Card, _screen_rect


def _http(method, path, data=None, ctype="application/json", timeout=10):
    req = urllib.request.Request(core.full_url(path), data=data, method=method,
                                 headers={"Content-Type": ctype, "User-Agent": f"FLA-Desktop/{core.VERSION}"})
    with urllib.request.urlopen(req, timeout=timeout, context=core._CTX) as r:
        return r.status, r.headers, r.read()


class _Sig(QObject):
    event = pyqtSignal(dict)
    created = pyqtSignal(object)
    qr = pyqtSignal(bytes)
    phone_frame = pyqtSignal(bytes)
    status = pyqtSignal(str)


class PhoneView(QWidget):
    """全屏显示手机画面 (位于批注画布之下)"""

    def __init__(self, on_close):
        super().__init__()
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool)
        self.pix = None
        self.on_close = on_close
        self.btn = TransparentToolButton(FIF.CLOSE, self)
        self.btn.setFixedSize(44, 44)
        self.btn.setToolTip("关闭手机画面")
        self.btn.clicked.connect(on_close)
        self.tip = CaptionLabel("等待手机画面…", self)
        self.tip.setStyleSheet("color:#bbb;")

    def set_frame(self, data: bytes):
        img = QImage.fromData(data, "JPG")
        if not img.isNull():
            self.pix = QPixmap.fromImage(img)
            self.tip.hide()
            self.update()

    def popup(self):
        self.setGeometry(_screen_rect())
        self.btn.move(self.width() - 60, 16)
        self.tip.move(self.width() // 2 - 60, self.height() // 2)
        self.show()

    def paintEvent(self, e):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor("#111111"))
        if self.pix:
            s = self.pix.size().scaled(self.size(), Qt.KeepAspectRatio)
            x, y = (self.width() - s.width()) // 2, (self.height() - s.height()) // 2
            p.setRenderHint(QPainter.SmoothPixmapTransform)
            p.drawPixmap(x, y, s.width(), s.height(), self.pix)


class CastPanel(_Card):
    def __init__(self, ctl):
        super().__init__(16)
        self.ctl = ctl
        lay = QVBoxLayout(self)
        lay.setContentsMargins(20, 14, 20, 18)
        lay.setSpacing(8)
        lay.setSizeConstraint(QVBoxLayout.SetFixedSize)
        top = QHBoxLayout()
        top.addWidget(SubtitleLabel("手机投屏 / 观看"))
        top.addStretch(1)
        x = TransparentToolButton(FIF.CLOSE, self)
        x.setToolTip("隐藏面板（投屏继续）")
        x.clicked.connect(self.hide)
        top.addWidget(x)
        lay.addLayout(top)
        self.qr = QLabel("正在创建会话…")
        self.qr.setFixedSize(240, 240)
        self.qr.setAlignment(Qt.AlignCenter)
        self.qr.setStyleSheet("background:#f5f5f5;border-radius:8px;")
        lay.addWidget(self.qr, 0, Qt.AlignHCenter)
        lay.addSpacing(6)
        self.code = QLabel("配对码 ----")
        self.code.setAlignment(Qt.AlignCenter)
        self.code.setStyleSheet("font-size:20px;font-weight:600;color:#111;")
        self.code.setFixedHeight(32)
        lay.addWidget(self.code)
        hint = BodyLabel("手机扫码（或浏览器打开 /cast.html 输入配对码）：\n· 观看电脑屏幕，并可用画笔/激光笔/橡皮直接在大屏批注、翻页\n· 投屏：把手机摄像头或照片投到大屏")
        hint.setWordWrap(True)
        lay.addWidget(hint)
        self.state = CaptionLabel("")
        lay.addWidget(self.state)
        row = QHBoxLayout()
        self.stop_btn = PushButton(FIF.CLOSE, "结束投屏")
        self.stop_btn.clicked.connect(ctl.stop)
        self.view_btn = PrimaryPushButton(FIF.PHONE, "显示手机画面")
        self.view_btn.clicked.connect(ctl.show_phone)
        row.addWidget(self.view_btn)
        row.addWidget(self.stop_btn)
        lay.addLayout(row)
        hint.setFixedWidth(300)
        self.adjustSize()

    def popup(self):
        r = _screen_rect()
        self.adjustSize()
        self.move(r.right() - self.width() - 24, r.top() + 60)
        self.show()
        self.raise_()


class CastController(QObject):
    def __init__(self, stage):
        super().__init__()
        self.stage = stage
        self.sig = _Sig()
        self.sid = ""
        self.code = ""
        self.active = False
        self.gen = 0
        self.uploading = False
        self.last_hash = ""
        self.last_upload = 0.0
        self.panel = CastPanel(self)
        self.phone_view = PhoneView(self.hide_phone)
        stage.add_floating(self.panel)
        self.sig.event.connect(self._on_event)
        self.sig.created.connect(self._on_created)
        self.sig.qr.connect(self._on_qr)
        self.sig.phone_frame.connect(self.phone_view.set_frame)
        self.sig.status.connect(lambda t: self.panel.state.setText(t))
        self.grab_timer = QTimer(self, interval=600, timeout=self._grab)

    # ---- 会话
    def toggle_panel(self):
        if not self.active:
            self.start()
        elif self.panel.isVisible():
            self.panel.hide()
        else:
            self.panel.popup()

    def start(self):
        self.active = True
        self.gen += 1
        gen = self.gen
        self.panel.qr.setText("正在创建会话…")
        self.panel.code.setText("配对码 ----")
        self.panel.state.setText("")
        self.panel.popup()

        def work():
            try:
                st, _, raw = _http("POST", "/api/remote/create",
                                   json.dumps({"title": "FLA 桌面投屏"}).encode())
                d = json.loads(raw.decode())
                self.sig.created.emit((gen, d))
            except Exception as e:  # noqa
                self.sig.created.emit((gen, {"error": str(e)}))
        threading.Thread(target=work, daemon=True).start()

    def _on_created(self, arg):
        gen, d = arg
        if gen != self.gen or not self.active:
            return
        if not d.get("session_id"):
            self.panel.qr.setText("创建失败\n请检查网络/服务器")
            self.panel.state.setText(str(d.get("error") or d.get("detail") or ""))
            self.active = False
            self.stage.dock.phone_btn.setChecked(False)
            return
        self.sid, self.code = d["session_id"], d["code"]
        self.panel.code.setText(f"配对码 {self.code}")
        self.panel.state.setText("等待手机连接…")
        self.stage.dock.phone_btn.setChecked(True)
        self.last_hash = ""
        self.grab_timer.start()
        sid, code = self.sid, self.code
        threading.Thread(target=self._poll_loop, args=(gen, sid), daemon=True).start()
        threading.Thread(target=self._phone_loop, args=(gen, sid, code), daemon=True).start()

        def qr():
            try:
                q = urllib.parse.urlencode({"kind": "cast", "base": cfg.server})
                _, _, raw = _http("GET", f"/api/remote/{sid}/qr?{q}")
                self.sig.qr.emit(raw)
            except Exception:
                pass
        threading.Thread(target=qr, daemon=True).start()

    def _on_qr(self, raw):
        pm = QPixmap()
        if pm.loadFromData(raw):
            self.panel.qr.setPixmap(pm.scaled(230, 230, Qt.KeepAspectRatio, Qt.SmoothTransformation))
            self.panel.adjustSize()

    def stop(self):
        self.active = False
        self.gen += 1
        self.grab_timer.stop()
        self.panel.hide()
        self.hide_phone()
        self.stage.dock.phone_btn.setChecked(False)
        sid = self.sid
        if sid:
            threading.Thread(target=lambda: self._safe(lambda: _http(
                "POST", f"/api/remote/{sid}/action", json.dumps({"action": "session_end"}).encode())),
                daemon=True).start()
        self.sid = ""

    @staticmethod
    def _safe(fn):
        try:
            fn()
        except Exception:
            pass

    # ---- 电脑画面 → 手机
    def _grab(self):
        if not self.active or not self.sid or self.uploading:
            return
        scr = QApplication.primaryScreen()
        pm = scr.grabWindow(0)
        if pm.isNull():
            return
        # 合成批注 (分层窗口截屏不一定包含画布)
        geo = _screen_rect()
        scale = pm.width() / max(1, geo.width())
        p = QPainter(pm)
        p.setRenderHint(QPainter.Antialiasing)
        if self.stage.ov.board:
            p.fillRect(pm.rect(), QColor("#FFFFFF"))
        self.stage.ov.paint_ink(p, scale)
        p.end()
        if pm.width() > 1280:
            pm = pm.scaledToWidth(1280, Qt.SmoothTransformation)
        ba = QByteArray()
        buf = QBuffer(ba)
        buf.open(QIODevice.WriteOnly)
        pm.save(buf, "JPG", 60)
        data = bytes(ba)
        h = hashlib.md5(data[::7]).hexdigest()
        if h == self.last_hash and time.time() - self.last_upload < 5:
            return
        self.last_hash = h
        self.uploading = True
        sid, code = self.sid, self.code

        def up():
            try:
                _http("POST", f"/api/remote/{sid}/frame/pc?code={code}", data, "image/jpeg", timeout=15)
                self.last_upload = time.time()
            except Exception:
                pass
            finally:
                self.uploading = False
        threading.Thread(target=up, daemon=True).start()

    # ---- 手机指令
    def _poll_loop(self, gen, sid):
        after = 0
        first = True
        while self.active and gen == self.gen:
            try:
                _, _, raw = _http("GET", f"/api/remote/{sid}/poll?after={after}", timeout=10)
                d = json.loads(raw.decode())
                evs = d.get("events") or []
                for e in evs:
                    after = max(after, int(e.get("idx") or 0))
                    if not first:
                        self.sig.event.emit(e)
                if first:
                    first = False
                    after = max(after, int(d.get("latest") or 0))
                time.sleep(0.12 if evs else 0.3)
            except Exception:
                time.sleep(1.5)

    def _on_event(self, e: dict):
        if not self.active:
            return
        t = e.get("type")
        if t == "hello" and e.get("role") != "desktop":
            self.panel.state.setText("手机已连接 ✓")
            return
        if t == "bye":
            return
        a = e.get("action") or ""
        d = e.get("data") or {}
        if e.get("sender") == "desktop":
            return
        ov = self.stage.ov
        if a in ("next", "prev", "first", "last", "black", "white", "board", "undo", "clear", "timer"):
            self.stage.handle(a)
        elif a == "ink":
            ov.remote_ink(d)
        elif a == "erase":
            ov.remote_erase(d)
        elif a == "laser":
            ov.remote_laser(d)
        elif a == "cast_start":
            self.show_phone()
        elif a == "cast_stop":
            self.hide_phone()
        elif a == "hello_phone":
            self.panel.state.setText("手机已连接 ✓")

    # ---- 手机画面 → 电脑
    def _phone_loop(self, gen, sid, code):
        seq = 0
        while self.active and gen == self.gen:
            try:
                st, hdr, raw = _http("GET", f"/api/remote/{sid}/frame/phone?code={code}&after={seq}", timeout=15)
                if st == 200 and raw:
                    seq = int(hdr.get("X-Seq") or seq + 1)
                    self.sig.phone_frame.emit(raw)
                    time.sleep(0.05)
                else:
                    time.sleep(0.35)
            except Exception:
                time.sleep(1.5)

    def show_phone(self):
        self.phone_view.popup()
        ov = self.stage.ov
        if ov.isVisible():
            ov.raise_()
        self.stage.refresh_holes()
        for w in self.stage.floating:
            if w.isVisible():
                w.raise_()
        if not self.stage.dock.isVisible() and not self.stage.dock.mini.isVisible():
            self.stage.start()

    def hide_phone(self):
        self.phone_view.hide()
