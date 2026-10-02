"""放映舞台: 悬浮工具盒 / 全屏批注画布 / 调色盘 / 计时器"""
from __future__ import annotations

import math
import time

from PyQt5.QtCore import QPoint, QPointF, QRectF, Qt, QTimer, pyqtSignal
from PyQt5.QtGui import QColor, QFont, QPainter, QPainterPath, QPen
from PyQt5.QtWidgets import QApplication, QFrame, QHBoxLayout, QLabel, QVBoxLayout, QWidget
from qfluentwidgets import FluentIcon as FIF
from qfluentwidgets import (PrimaryPushButton, PushButton, SegmentedWidget, ToolTipFilter, ToolTipPosition,
                            TransparentToggleToolButton, TransparentToolButton)

from . import core

COLORS = ["#111111", "#E53935", "#1E88E5", "#43A047", "#FDD835", "#FB8C00", "#FFFFFF"]
WIDTHS = [3, 6, 12]


def _screen_rect():
    return QApplication.primaryScreen().geometry()


class _Card(QWidget):
    """白色圆角浮动卡片 (可拖动)"""

    def __init__(self, radius=14, parent=None):
        super().__init__(parent)
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self._r = radius
        self._drag = None

    def paintEvent(self, e):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        rect = QRectF(self.rect()).adjusted(1, 1, -1, -1)
        p.setPen(QPen(QColor(0, 0, 0, 40), 1))
        p.setBrush(QColor(255, 255, 255, 245))
        p.drawRoundedRect(rect, self._r, self._r)

    def mousePressEvent(self, e):
        if e.button() == Qt.LeftButton:
            self._drag = e.globalPos() - self.frameGeometry().topLeft()

    def mouseMoveEvent(self, e):
        if self._drag is not None and e.buttons() & Qt.LeftButton:
            self.move(e.globalPos() - self._drag)

    def mouseReleaseEvent(self, e):
        self._drag = None


# ================================================================== 画布
class Overlay(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setAttribute(Qt.WA_ShowWithoutActivating)
        self.tool = "mouse"
        self.color = QColor(COLORS[1])
        self.width_ = WIDTHS[0]
        self.page = 1
        self.board = False
        self.pages: dict = {}           # page -> [stroke]; 'board' 为白板页
        self.cur = None
        self.laser: list = []
        self.laser_timer = QTimer(self, interval=30, timeout=self._laser_tick)
        self.setCursor(Qt.CrossCursor)

    # ---- 数据
    def strokes(self) -> list:
        return self.pages.setdefault("board" if self.board else self.page, [])

    def has_ink(self) -> bool:
        return bool(self.strokes())

    # ---- 状态切换
    def set_tool(self, tool: str):
        self.tool = tool
        self._sync_visibility()

    def set_board(self, on: bool):
        self.board = on
        if on and self.tool == "mouse":
            self.tool = "pen"
        self._sync_visibility()
        self.update()

    def set_page(self, page: int):
        self.page = max(1, page)
        self.update()

    def _sync_visibility(self):
        self.setGeometry(_screen_rect())
        passthrough = self.tool == "mouse" and not self.board
        if passthrough and not self.has_ink():
            self.hide()
            return
        self.setWindowFlag(Qt.WindowTransparentForInput, passthrough)
        self.show()
        if not passthrough:
            self.raise_()
            self.activateWindow()
        self.update()

    def clear(self):
        self.strokes().clear()
        self._sync_visibility()

    def undo(self):
        if self.strokes():
            self.strokes().pop()
            self.update()

    # ---- 绘制
    def paintEvent(self, e):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        if self.board:
            p.fillRect(self.rect(), QColor("#FFFFFF"))
        elif self.tool != "mouse":
            p.fillRect(self.rect(), QColor(0, 0, 0, 1))   # 近乎透明但可接收鼠标
        for s in self.strokes() + ([self.cur] if self.cur else []):
            self._draw_stroke(p, s)
        now = time.time()
        for (pt, t) in self.laser:
            a = max(0.0, 1 - (now - t) / 0.45)
            p.setPen(Qt.NoPen)
            p.setBrush(QColor(255, 30, 30, int(200 * a)))
            r = 4 + 5 * a
            p.drawEllipse(QPointF(pt), r, r)

    @staticmethod
    def _draw_stroke(p: QPainter, s: dict):
        pts = s["pts"]
        if not pts:
            return
        c = QColor(s["color"])
        if s["tool"] == "marker":
            c.setAlpha(90)
        pen = QPen(c, s["w"], Qt.SolidLine, Qt.RoundCap, Qt.RoundJoin)
        p.setPen(pen)
        p.setBrush(Qt.NoBrush)
        if len(pts) == 1:
            p.drawPoint(pts[0])
            return
        path = QPainterPath(QPointF(pts[0]))
        for i in range(1, len(pts) - 1):
            mid = QPointF((pts[i].x() + pts[i + 1].x()) / 2, (pts[i].y() + pts[i + 1].y()) / 2)
            path.quadTo(QPointF(pts[i]), mid)
        path.lineTo(QPointF(pts[-1]))
        p.drawPath(path)

    # ---- 输入
    def mousePressEvent(self, e):
        if e.button() == Qt.RightButton:
            self.set_tool("mouse")
            self.tool_changed.emit("mouse")
            return
        if self.tool in ("pen", "marker"):
            w = self.width_ * (3 if self.tool == "marker" else 1)
            self.cur = {"tool": self.tool, "color": self.color.name(), "w": w, "pts": [e.pos()]}
        elif self.tool == "eraser":
            self._erase(e.pos())
        elif self.tool == "laser":
            self._laser_add(e.pos())

    def mouseMoveEvent(self, e):
        if self.tool == "laser":
            self._laser_add(e.pos())
            return
        if not (e.buttons() & Qt.LeftButton):
            return
        if self.cur is not None:
            self.cur["pts"].append(e.pos())
            self.update()
        elif self.tool == "eraser":
            self._erase(e.pos())

    def mouseReleaseEvent(self, e):
        if self.cur is not None:
            self.strokes().append(self.cur)
            self.cur = None
            self.update()

    def _erase(self, pos: QPoint, r: float = 22):
        keep = [s for s in self.strokes()
                if not any(math.hypot(pt.x() - pos.x(), pt.y() - pos.y()) < r + s["w"] / 2 for pt in s["pts"])]
        if len(keep) != len(self.strokes()):
            self.strokes()[:] = keep
            self.update()

    def _laser_add(self, pos):
        self.laser.append((QPoint(pos), time.time()))
        if not self.laser_timer.isActive():
            self.laser_timer.start()
        self.update()

    def _laser_tick(self):
        now = time.time()
        self.laser = [x for x in self.laser if now - x[1] < 0.45]
        if not self.laser:
            self.laser_timer.stop()
        self.update()

    def keyPressEvent(self, e):
        k = e.key()
        if k == Qt.Key_Escape:
            self.set_board(False) if self.board else None
            self.set_tool("mouse")
            self.tool_changed.emit("mouse")
        elif k == Qt.Key_Z and e.modifiers() & Qt.ControlModifier:
            self.undo()
        elif k in (Qt.Key_Right, Qt.Key_Down, Qt.Key_PageDown, Qt.Key_Space, Qt.Key_Return):
            self.key_command.emit("next")
        elif k in (Qt.Key_Left, Qt.Key_Up, Qt.Key_PageUp, Qt.Key_Backspace):
            self.key_command.emit("prev")

    tool_changed = pyqtSignal(str)
    key_command = pyqtSignal(str)


# ================================================================== 调色盘
class Palette(_Card):
    picked = pyqtSignal()

    def __init__(self, overlay: Overlay):
        super().__init__(12)
        self.ov = overlay
        lay = QVBoxLayout(self)
        lay.setContentsMargins(12, 10, 12, 10)
        row = QHBoxLayout()
        row.setSpacing(6)
        for c in COLORS:
            b = QFrame()
            b.setFixedSize(26, 26)
            b.setCursor(Qt.PointingHandCursor)
            b.setStyleSheet(f"background:{c};border:1px solid #bbb;border-radius:13px;")
            b.mousePressEvent = (lambda _e, c=c: self._color(c))
            row.addWidget(b)
        lay.addLayout(row)
        self.seg = SegmentedWidget(self)
        for i, (w, label) in enumerate(zip(WIDTHS, ["细", "中", "粗"])):
            self.seg.addItem(str(w), label, onClick=lambda w=w: self._width(w))
        self.seg.setCurrentItem(str(WIDTHS[0]))
        lay.addWidget(self.seg)
        self.adjustSize()

    def _color(self, c):
        self.ov.color = QColor(c)
        self.picked.emit()
        self.hide()

    def _width(self, w):
        self.ov.width_ = w


# ================================================================== 计时器
class TimerWindow(_Card):
    def __init__(self):
        super().__init__(16)
        self.down = True
        self.total = 300
        self.left = 300
        self.running = False
        self.tick = QTimer(self, interval=1000, timeout=self._tick)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(18, 12, 18, 14)
        top = QHBoxLayout()
        self.mode = SegmentedWidget(self)
        self.mode.addItem("down", "倒计时", onClick=lambda: self._set_mode(True))
        self.mode.addItem("up", "正计时", onClick=lambda: self._set_mode(False))
        self.mode.setCurrentItem("down")
        top.addWidget(self.mode)
        top.addStretch(1)
        close = TransparentToolButton(FIF.CLOSE, self)
        close.clicked.connect(self.hide)
        top.addWidget(close)
        lay.addLayout(top)
        self.label = QLabel("05:00")
        f = QFont("Segoe UI", 54)
        f.setBold(True)
        self.label.setFont(f)
        self.label.setAlignment(Qt.AlignCenter)
        lay.addWidget(self.label)
        self.presets = QHBoxLayout()
        for m in (1, 3, 5, 10, 20):
            b = PushButton(f"{m} 分")
            b.clicked.connect(lambda _=False, m=m: self._preset(m * 60))
            self.presets.addWidget(b)
        lay.addLayout(self.presets)
        acts = QHBoxLayout()
        self.go = PrimaryPushButton(FIF.PLAY, "开始")
        self.go.clicked.connect(self.toggle)
        rst = PushButton(FIF.SYNC, "归零")
        rst.clicked.connect(self.reset)
        acts.addWidget(self.go)
        acts.addWidget(rst)
        lay.addLayout(acts)
        self.setFixedWidth(380)
        self.adjustSize()

    def _set_mode(self, down):
        self.down = down
        self.reset()

    def _preset(self, s):
        self.down = True
        self.mode.setCurrentItem("down")
        self.total = s
        self.reset()

    def toggle(self):
        self.running = not self.running
        self.go.setText("暂停" if self.running else "开始")
        self.go.setIcon(FIF.PAUSE if self.running else FIF.PLAY)
        (self.tick.start() if self.running else self.tick.stop())

    def reset(self):
        self.running = False
        self.tick.stop()
        self.go.setText("开始")
        self.go.setIcon(FIF.PLAY)
        self.left = self.total if self.down else 0
        self._show()

    def _tick(self):
        if self.down:
            self.left -= 1
            if self.left <= 0:
                self.left = 0
                self.toggle()
                QApplication.beep()
                self.label.setStyleSheet("color:#E53935;")
                QTimer.singleShot(4000, lambda: self.label.setStyleSheet(""))
        else:
            self.left += 1
        self._show()

    def _show(self):
        m, s = divmod(self.left, 60)
        self.label.setText(f"{m:02d}:{s:02d}")

    def popup(self):
        r = _screen_rect()
        self.move(r.center().x() - self.width() // 2, r.top() + 80)
        self.show()
        self.raise_()


# ================================================================== 悬浮工具盒
class Dock(_Card):
    command = pyqtSignal(str)

    def __init__(self):
        super().__init__(14)
        self.bar = QHBoxLayout(self)
        self.bar.setContentsMargins(10, 6, 10, 6)
        self.bar.setSpacing(2)
        self.tools = {}
        self.page_label = QLabel("1")
        self.page_label.setMinimumWidth(28)
        self.page_label.setAlignment(Qt.AlignCenter)

        def btn(icon, tip, cmd, toggle=False):
            b = (TransparentToggleToolButton if toggle else TransparentToolButton)(icon, self)
            b.setFixedSize(40, 40)
            b.setToolTip(tip)
            b.installEventFilter(ToolTipFilter(b, 300, ToolTipPosition.TOP))
            b.clicked.connect(lambda _=False: self.command.emit(cmd))
            self.bar.addWidget(b)
            return b

        def sep():
            f = QFrame()
            f.setFixedSize(1, 26)
            f.setStyleSheet("background:#e3e3e3;")
            self.bar.addSpacing(4)
            self.bar.addWidget(f)
            self.bar.addSpacing(4)

        btn(FIF.LEFT_ARROW, "上一页", "prev")
        self.bar.addWidget(self.page_label)
        btn(FIF.RIGHT_ARROW, "下一页", "next")
        sep()
        for icon, tip, key in [(FIF.MOVE, "鼠标 (穿透操作)", "mouse"), (FIF.PENCIL_INK, "画笔", "pen"),
                               (FIF.HIGHTLIGHT, "荧光笔", "marker"), (FIF.CLEAR_SELECTION, "激光笔", "laser"),
                               (FIF.ERASE_TOOL, "橡皮擦", "eraser")]:
            self.tools[key] = btn(icon, tip, key, toggle=True)
        btn(FIF.PALETTE, "颜色与粗细", "palette")
        btn(FIF.DELETE, "清除本页笔迹", "clear")
        sep()
        self.board_btn = btn(FIF.QUICK_NOTE, "白板", "board", toggle=True)
        btn(FIF.BRIGHTNESS, "黑屏 / 恢复", "black")
        btn(FIF.STOP_WATCH, "计时器", "timer")
        sep()
        btn(FIF.HOME, "打开主窗口", "main")
        btn(FIF.MINIMIZE, "收起工具盒", "collapse")
        btn(FIF.CLOSE, "结束放映工具", "end")
        self.set_tool("mouse")
        self.adjustSize()

        self.mini = _Card(22)
        ml = QHBoxLayout(self.mini)
        ml.setContentsMargins(4, 4, 4, 4)
        mb = TransparentToolButton(FIF.EDUCATION, self.mini)
        mb.setFixedSize(36, 36)
        mb.setToolTip("展开 FLA 工具盒")
        mb.clicked.connect(self.expand)
        ml.addWidget(mb)
        self.mini.adjustSize()

    def set_tool(self, tool):
        for k, b in self.tools.items():
            b.setChecked(k == tool)

    def set_board(self, on):
        self.board_btn.setChecked(on)

    def set_page(self, n):
        self.page_label.setText(str(n))

    def popup(self):
        r = _screen_rect()
        self.adjustSize()
        self.move(r.center().x() - self.width() // 2, r.bottom() - self.height() - 56)
        self.mini.hide()
        self.show()
        self.raise_()

    def collapse(self):
        r = _screen_rect()
        self.hide()
        self.mini.move(r.right() - self.mini.width() - 16, r.bottom() - self.mini.height() - 120)
        self.mini.show()
        self.mini.raise_()

    def expand(self):
        self.mini.hide()
        self.show()
        self.raise_()

    def close_all(self):
        self.hide()
        self.mini.hide()


# ================================================================== 舞台控制器
class Stage:
    def __init__(self, show_main):
        self.show_main = show_main
        self.ov = Overlay()
        self.dock = Dock()
        self.palette = Palette(self.ov)
        self.timer = TimerWindow()
        self.dock.command.connect(self.handle)
        self.ov.tool_changed.connect(self.dock.set_tool)
        self.ov.key_command.connect(self.handle)
        self.palette.picked.connect(lambda: self.handle("pen") if self.ov.tool not in ("pen", "marker") else None)

    def start(self):
        self.ov.page = 1
        self.dock.set_page(1)
        self.dock.popup()

    def handle(self, cmd: str):
        ov = self.ov
        if cmd in ("next", "prev", "first", "last"):
            if ov.board:
                return
            if ov.tool != "mouse":
                ov.hide()  # 让按键送到放映窗口
            core.focus_slideshow()
            core.send_key(cmd)
            page = {"next": ov.page + 1, "prev": ov.page - 1, "first": 1}.get(cmd, ov.page)
            ov.set_page(page)
            self.dock.set_page(ov.page)
            QTimer.singleShot(120, ov._sync_visibility)
        elif cmd in ("mouse", "pen", "marker", "laser", "eraser"):
            ov.set_tool(cmd)
            self.dock.set_tool(cmd)
            self.dock.raise_()
        elif cmd == "palette":
            self.palette.adjustSize()
            g = self.dock.geometry()
            self.palette.move(g.center().x() - self.palette.width() // 2, g.top() - self.palette.height() - 8)
            self.palette.setVisible(not self.palette.isVisible())
            self.palette.raise_()
        elif cmd == "clear":
            ov.clear()
        elif cmd == "board":
            ov.set_board(not ov.board)
            self.dock.set_board(ov.board)
            self.dock.set_tool(ov.tool)
            self.dock.raise_()
        elif cmd in ("black", "white"):
            core.focus_slideshow()
            core.send_key(cmd)
        elif cmd == "timer":
            self.timer.hide() if self.timer.isVisible() else self.timer.popup()
        elif cmd == "main":
            self.show_main()
        elif cmd == "collapse":
            self.palette.hide()
            self.dock.collapse()
        elif cmd in ("dock_toggle",):
            self.dock.collapse() if self.dock.isVisible() else self.dock.popup()
        elif cmd == "end":
            ov.set_board(False)
            ov.set_tool("mouse")
            ov.hide()
            self.palette.hide()
            self.dock.close_all()
        if self.dock.isVisible():
            self.dock.raise_()
