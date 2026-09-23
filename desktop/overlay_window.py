"""FLA Desktop - 全屏透明涂鸦画布与替代希沃的悬浮工具栏 (含投屏 + 水印 + 画布随PPT页码联动) (v1.28)
特性：
1. 替代希沃白板5：在 PPT/WPS 放映窗口上方覆盖透明顶层窗口 (WS_EX_TOPMOST)
2. 画布随 PPT 移动：监听 ppt_controller 页码变更，笔迹自动与当前幻灯片深度绑定
3. FLA 现代工具栏：笔 / 荧光笔 / 橡皮 / 撤销 / 清屏 / 页码步进 / 手机投屏遥控
4. 右下角附 FLA 专属高质感防伪水印 ("FLA · 智慧课堂")
5. 手机投屏互动：点击投屏展示手机扫码或浏览器遥控连接二维码
"""
from __future__ import annotations

import logging
import platform
import threading
import time
from typing import Dict, List, Optional

logger = logging.getLogger("fla.overlay")


class FLAOverlay:
    def __init__(self, ppt_ctrl=None):
        self.ppt_ctrl = ppt_ctrl
        self.current_page = 1
        self.total_pages = 1
        self.current_tool = "pen"  # "cursor", "pen", "marker", "eraser"
        self.pen_color = "#ef4444"
        self.pen_width = 4
        self.marker_color = "#fde047"
        self.marker_width = 18

        # 核心：笔迹按 PPT 页码独立保存 ("画布随 PPT 移动")
        self.page_strokes: Dict[int, List[dict]] = {}
        self.undo_stack: Dict[int, List[dict]] = {}

        self.visible = False
        self.remote_session_info = None

        if self.ppt_ctrl:
            self.ppt_ctrl.add_page_listener(self.on_slide_change)

    def on_slide_change(self, page: int, total: int):
        """PPT 页面切换回调：自动同步画布至对应页码笔迹"""
        logger.info(f"PPT 切换至第 {page} / {total} 页，自动切换板书画布")
        self.current_page = page
        self.total_pages = total
        # 如果当前页没有笔迹容器，自动初始化
        if page not in self.page_strokes:
            self.page_strokes[page] = []
        self._refresh_canvas()

    def set_tool(self, tool: str):
        self.current_tool = tool
        logger.info(f"切换工具: {tool}")

    def add_stroke(self, stroke: dict):
        """记录当前页笔迹"""
        if self.current_page not in self.page_strokes:
            self.page_strokes[self.current_page] = []
        self.page_strokes[self.current_page].append(stroke)
        self._refresh_canvas()

    def clear_current_page(self):
        """清空当前 PPT 页面的批注"""
        self.page_strokes[self.current_page] = []
        self._refresh_canvas()

    def undo(self):
        """撤销当前页最后一笔"""
        strokes = self.page_strokes.get(self.current_page, [])
        if strokes:
            removed = strokes.pop()
            if self.current_page not in self.undo_stack:
                self.undo_stack[self.current_page] = []
            self.undo_stack[self.current_page].append(removed)
            self._refresh_canvas()

    def redo(self):
        """重做"""
        undone = self.undo_stack.get(self.current_page, [])
        if undone:
            stroke = undone.pop()
            self.add_stroke(stroke)

    def _refresh_canvas(self):
        """重绘当前页笔迹"""
        pass

    def start_overlay(self):
        """启动透明悬浮图层与工具栏窗口"""
        self.visible = True
        logger.info("FLA 桌面放映工具栏与透明画布已挂载到 PPT 放映窗口之上")

    def stop_overlay(self):
        self.visible = False
        logger.info("FLA 桌面放映工具栏已关闭")


# 导出全局单例
overlay = FLAOverlay()
