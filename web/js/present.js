/* FLA v1.26 - 放映引擎 (Tier 2): 全屏翻页 + 元素级动画 + 放映中板书
 * v1.26: 修图片/音视频放映(此前一律走 pdf.js → 请求 /pdf 400 → 整页报错崩死);
 *        图片=原生渲染, 音视频=<video>/<audio>+Range流式, 非通用格式(mkv/wmv/avi..)服务端 ffmpeg 转码 mp4;
 *        PDF 加载失败提示友好化(区分 400/409/403)
 * v1.25: 工具栏顶部新增"光标/正常模式"按钮(点击画面即翻 PPT, 笔迹层完全穿透);
 *        修 msTrack 未 return → 原生 onKey 泄漏进微软模式, 按 Esc 直接关掉整个放映页(v1.21 起存在);
 *        补 toastMs 定义(修 v1.23 起 4 处 ReferenceError: 板书加页/开场引导等提示从未显示);
 *        教师认证徽章/证书卡 绚丽重绘(见 app.js + style.css)
 * v1.24: 删除视觉页码同步; 工具栏移到左右两侧竖排(底部全让给微软); 板书页 ‹＋›(独立于PPT);
 *        工具弹窗改为"再点一次工具"打开(修弹窗挡画布吞笔迹); 全套新图标+动画
 * v1.23: 工具栏=白板同款悬浮胶囊(左右两段, 中央完全让给微软翻页控件, 任意分辨率不遮挡);
 *        板中板(独立黑板+独立加页, 滑落/收起); msTrack 载入历史批注(修重开覆盖丢失); 站点背景
 * v1.22: 微软放映底栏开"页码窗"(真页码可见+可OCR) / 视觉同步修复(裁剪对准页码窗+二值化+psm7,
 *        识别结果实时显示✓N/T, 板书自动跟随) / ‹ › 贴纸保持点击穿透
 * 纯 ES5(兼容学校旧浏览器 Chrome 60+), 依赖 pdf.js 2.16 legacy 经典脚本.
 * v1.14: 表格 HTML 渲染 / 不支持内容主 PDF 裁剪元素 / 退出+强调动画 / 禁止整页静态回退
 * 入口: /present.html?fid=ID&token=TOKEN
 * 与查看器(viewer.js)批注数据完全互通: {pages:[{t,n,pid,bg}], strokes:{pid:[...]}}
 */
(function () {
  'use strict';

  var FONT_STACK = '"Microsoft YaHei","PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Noto Sans SC","Cambria Math","STIX Two Math",sans-serif';
  var BLANK_BG = { w: '#ffffff', k: '#15181d', g: '#1c3b2d' };

  /* ---------- 参数与工具 ---------- */
  function qp(k) {
    var m = new RegExp('[?&]' + k + '=([^&]*)').exec(location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  }
  function storeToken() {
    try { return localStorage.getItem('token') || ''; } catch (e) { return ''; }
  }
  var FID = parseInt(qp('fid'), 10) || 0;
  var TRACK = qp('track') || '';
  var TOKEN = qp('token') || storeToken();
  var AUTH = { Authorization: 'Bearer ' + TOKEN };

  function jget(url) {
    return fetch(url, { headers: AUTH }).then(function (r) {
      if (r.status === 401) throw new Error('登录已过期, 请回到课件页重新进入放映');
      if (!r.ok) throw new Error('请求失败(' + r.status + ')');
      return r.json();
    });
  }
  function bget(url) {
    return fetch(url, { headers: AUTH }).then(function (r) {
      if (!r.ok) throw new Error('素材加载失败');
      return r.blob();
    });
  }
  function loadScript(src) {
    return new Promise(function (res, rej) {
      if (document.querySelector('script[data-fla="' + src + '"]')) return res();
      var s = document.createElement('script');
      s.src = src; s.setAttribute('data-fla', src);
      s.onload = function () { res(); };
      s.onerror = function () { rej(new Error('组件加载失败: ' + src)); };
      document.head.appendChild(s);
    });
  }
  function el(tag, cls, css) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (css) d.style.cssText = css;
    return d;
  }
  function fmtT(sec) {
    var m = Math.floor(sec / 60), s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* ---------- 状态 ---------- */
  var S = {
    meta: null, manifest: null, pages: [], strokes: {},
    cur: -1, doc: null, bgDoc: null, bgFailed: false, pdfjs: null,
    imgMap: {}, boxEl: null, box: { w: 960, h: 540 }, dpr: 1,
    pageEls: [], playQueue: [], pi: 0, autoTimers: [],
    tool: 'cursor', pen: { color: '#111111', width: 3 },
    marker: { color: '#fde047', width: 16 }, eraser: { width: 28 },
    drawing: null, compare: false, dirty: false, saveT: 0,
    t0: Date.now(), timerOn: true, hideT: 0, lid: 0,
    seq: 0, lastW: 0, lastH: 0
  };

  function curPage() { return S.pages[S.cur] || { t: 'blank', pid: '_x', w: 1280, h: 720 }; }
  function mPage(n) {
    if (!S.manifest || !S.manifest.pages) return null;
    return S.manifest.pages[n] || null;
  }

  /* ---------- 启动 ---------- */
  function fail(msg) {
    var b = document.getElementById('pboot');
    if (b) { b.textContent = msg; b.className = 'perr'; }
    throw new Error(msg);
  }

  function boot() {
    if (!FID) return fail('参数缺失: 请从课件页点击「放映」进入');
    if (!TOKEN) return fail('请先登录 FLA, 再从课件页点击「放映」');
    Promise.all([
      jget('/api/files/' + FID + '/meta'),
      jget('/api/files/' + FID + '/annotations').catch(function () { return null; }),
      jget('/api/files/' + FID + '/anim').catch(function () { return null; })
    ]).then(function (rs) {
      S.meta = rs[0];
      if (S.meta.status && S.meta.status !== 'ready') return fail('文档尚未转换完成, 请稍后再试');
      if (TRACK === 'ms' && S.meta.kind === 'office' &&
          /^(ppt|pptx|doc|docx|xls|xlsx)$/.test(S.meta.ext || '')) {
        return msTrack();  // v1.18 微软放映轨道(透明伴飞层)
      }
      S.manifest = rs[2] && rs[2].pages && rs[2].v >= 2 && rs[2].pages.length ? rs[2] : null;
      var ann = rs[1];
      S.strokes = (ann && ann.strokes) || {};
      if (ann && ann.bb && ann.bb.n) S.bbN = ann.bb.n;
      var pages = (ann && ann.pages && ann.pages.length) ? ann.pages.slice() : null;
      if (pages) {
        var allBlank = pages.every(function (q) { return q.t === 'blank'; });
        var hasInk = false;
        for (var k in S.strokes) if ((S.strokes[k] || []).length) { hasInk = true; break; }
        if (allBlank && !hasInk && (S.meta.pages || 1) > pages.length) pages = null;
      }
      S.pages = pages || [];
      /* v1.26: 图片/音视频不走 pdf.js — 单页原生渲染
       * (修: 此前一律 openPdf → /api/files/{id}/pdf 对图片/媒体返回 400 → 整页报错) */
      if (S.meta.kind === 'image' || S.meta.kind === 'video' || S.meta.kind === 'audio') {
        var mt = S.meta.kind === 'image' ? 'image' : 'media';
        if (!S.pages.length || !S.pages[0] || S.pages[0].t !== mt) S.pages = [{ t: mt, n: 0, pid: 'p0' }];
        return Promise.resolve();
      }
      return openPdf().then(function (numPages) {
        if (!S.pages.length || (S.pages.every(function (q) { return q.t === 'pdf'; }) && S.pages.length !== numPages)) {
          S.pages = [];
          for (var i = 0; i < numPages; i++) S.pages.push({ t: 'pdf', n: i, pid: 'p' + i });
        }
        return prefetchImgs();
      });
    }).then(function () {
      if (S.msMode) return;   /* v1.25: 微软轨道自建 UI, 原生 UI/键盘不再叠加(修 Esc 关标签页) */
      buildUI();
      showPage(0);
    }).catch(function (e) { fail(e.message || '载入失败'); });
  }

  /* ---------- v1.21 微软放映轨道「伴飞层 v3」----------
   * 底部不透明工具栏(白板同款)整条遮住微软控件; 仅 ◀/▶ 两窗透明可穿透;
   * 工具: 选择/笔/荧光笔/几何图形/文本/激光笔/橡皮 + 撤销/重做/清空;
   * 页码: 视觉同步(需 HTTPS) 或 手动; 触摸: touch-action + 指针捕获 */
  function msTrack() {
    S.msMode = true;   /* v1.25: 标记微软轨道 — boot() 不再构建原生 UI(修: 原生 onKey 泄漏, Esc 会 window.close() 关掉整个放映页) */
    var isPpt = /^(ppt|pptx)$/.test(S.meta.ext || '');
    var totPages = S.meta.pages || 1;
    var arJob = jget('/api/files/' + FID + '/anim').then(function (m) {
      return (m && m.slideW && m.slideH) ? (m.slideW / m.slideH) : 1.77778;
    }).catch(function () { return 1.77778; });
    Promise.all([jget('/api/files/' + FID + '/share-link'), arJob,
      jget('/api/files/' + FID + '/annotations').catch(function () { return null; })]).then(function (rs) {
      var sl = rs[0], ar = rs[1];
      var msUrl = 'https://view.officeapps.live.com/op/embed.aspx?src=' + encodeURIComponent(sl.direct);
      if (isPpt) msUrl += '&wdStartOn=1&wdPrint=0&wdEmbedCode=0&wdAr=' + ar;
      document.title = (S.meta.name || '课件') + ' - FLA 放映';
      document.body.innerHTML = '';
      document.body.style.cssText = 'margin:0;overflow:hidden;background:#000';

      S.msPage = 1;
      S.pages = [];
      for (var i = 0; i < totPages; i++) S.pages.push({ t: 'ms', n: i, pid: 'm' + i, bg: 'w' });
      S.cur = 0;
      /* v1.23: 载入历史批注(否则重开会用空栈覆盖丢失旧板书) + 板中板页数 */
      if (rs[2] && rs[2].strokes) S.strokes = rs[2].strokes;
      if (rs[2] && rs[2].bb && rs[2].bb.n) S.bbN = rs[2].bb.n;
      if (rs[2] && rs[2].pages && rs[2].pages.length > totPages) {
        /* 恢复放映中加的板书页 */
        S.pages = rs[2].pages.slice(0, rs[2].pages.length);
        totPages = S.pages.length;
      }
      function msPid() { return 'm' + (S.msPage - 1); }

      var wrap = el('div', '', 'position:fixed;left:0;top:0;right:0;bottom:0;background:#000');
      var fr = el('iframe', '', 'position:absolute;left:0;top:0;width:100%;height:100%;border:0;background:#000;z-index:1');
      fr.setAttribute('allowfullscreen', 'true');
      fr.src = msUrl;
      wrap.appendChild(fr);

      /* ---------- 图标(与白板 ui.js 同源) ---------- */
      function icon(name, sz) {
        var P = {
          cursor: '<path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/>',
          select: '<circle cx="11" cy="11" r="7.5" stroke-dasharray="3.2 3.2"/><path d="M15.8 15.8 21 21l-1.8.6.6-1.8z" fill="currentColor" stroke="none"/>',
          pen: '<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
          marker: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4l8 8Z"/>',
          shapes: '<rect x="3" y="3" width="8.5" height="8.5" rx="1.5"/><circle cx="16.5" cy="16.5" r="5"/>',
          text: '<path d="M5 7V5h14v2"/><path d="M12 5v14"/><path d="M9 19h6"/>',
          laser: '<circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/><path d="M12 3.5v2.6M12 17.9v2.6M3.5 12h2.6M17.9 12h2.6M5.9 5.9l1.9 1.9M16.2 16.2l1.9 1.9M18.1 5.9l-1.9 1.9M7.8 16.2l-1.9 1.9"/>',
          eraser: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
          undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
          redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
          trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/>',
          full: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="MM16 21h3a2 2 0 0 0 2-2v-3"/>',
          board: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M12 17v3M8 21h8"/>',
          plusPage: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 11v6M9 14h6"/>',
          bolt: '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/>',
          square: '<rect x="4.5" y="4.5" width="15" height="15" rx="2"/>',
          chevL: '<path d="m15 18-6-6 6-6"/>',
          chevR: '<path d="m9 18 6-6-6-6"/>'
        };
        return '<svg width="' + (sz || 20) + '" height="' + (sz || 20) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (P[name] || '') + '</svg>';
      }

      /* ---------- 配置(与白板一致) ---------- */
      var PEN_COLORS = ['#1f2937', '#ef4444', '#2563eb', '#059669', '#f59e0b', '#ffffff'];
      var MARKER_COLORS = ['#fde047', '#86efac', '#93c5fd', '#f9a8d4', '#fdba74'];
      var SHAPE_COLORS = ['#111827', '#ef4444', '#2563eb', '#059669', '#9333ea', '#ffffff'];
      var TEXT_COLORS = ['#1f2937', '#ef4444', '#2563eb', '#059669', '#f59e0b', '#ffffff'];
      var SHAPE_LIST = [['line', '直线'], ['arrow', '箭头'], ['rect', '矩形'], ['ellipse', '椭圆'], ['triangle', '三角形']];
      var SHAPE_MINI = {
        line: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 19L19 5"/></svg>',
        arrow: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19L19 5"/><path d="M13 5h6v6"/></svg>',
        rect: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="6" width="16" height="12" rx="1"/></svg>',
        ellipse: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="12" rx="9" ry="7"/></svg>',
        triangle: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 4l9 16H3z"/></svg>'
      };
      var cfg = {
        pen: { color: '#ef4444', width: 4 },
        marker: { color: '#fde047', width: 16 },
        shape: { type: 'rect', color: '#ef4444', width: 3 },
        text: { color: '#ef4444', size: 28 }
      };

      /* ---------- 墨迹画布 ---------- */
      var ink = el('canvas', '', 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;touch-action:none;z-index:5');
      wrap.appendChild(ink);
      var ictx = ink.getContext('2d');
      var tool = 'cursor';
      var drawing = null;
      var laserDots = [];
      var selId = null, selOff = null;

      function canvasSize() {
        S.dpr = window.devicePixelRatio || 1;
        ink.width = Math.round(window.innerWidth * S.dpr);
        ink.height = Math.round(window.innerHeight * S.dpr);
        inkRedrawMs();
      }
      function toVirt(x, y) { return [x / window.innerWidth * 1280, y / window.innerHeight * 720]; }
      function uid() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

      /* 撤销/重做: 每页操作栈 */
      var ops = {};   /* pid -> [{op:'add'|'del'|'move'|'clear', ...}] */
      var redos = {};
      function opPush(pid, o) {
        (ops[pid] = ops[pid] || []).push(o);
        if (ops[pid].length > 200) ops[pid].shift();
        redos[pid] = [];
        saveSoon();
      }
      function opApply(pid, o, undo) {
        var arr = S.strokes[pid] || [];
        if (o.op === 'add') {
          if (undo) { var i = arr.indexOf(o.s); if (i >= 0) arr.splice(i, 1); }
          else arr.push(o.s);
        } else if (o.op === 'del') {
          if (undo) arr.push(o.s);
          else { var j = arr.indexOf(o.s); if (j >= 0) arr.splice(j, 1); }
        } else if (o.op === 'move') {
          var s = o.s, before = undo ? o.after : o.before, after2 = undo ? o.before : o.after;
          if (s.tool === 'shape') { s.pts = after2; }
          else if (s.tool === 'text') { s.pts = [after2]; }
          else { s.pts.forEach(function (pt, k) { pt[0] = before[k][0] + (after2[0][0] - before[0][0]); pt[1] = before[k][1] + (after2[0][1] - before[0][1]); }); }
        } else if (o.op === 'clear') {
          if (undo) { o.list.forEach(function (x) { arr.push(x); }); }
          else { o.list.forEach(function (x) { var k = arr.indexOf(x); if (k >= 0) arr.splice(k, 1); }); }
        }
        S.strokes[pid] = arr;
      }
      function doUndoMs() {
        var pid = msPid(), st = ops[pid] || [];
        if (!st.length) return;
        var o = st.pop();
        opApply(pid, o, true);
        (redos[pid] = redos[pid] || []).push(o);
        if (selId && (o.op === 'del' || o.op === 'clear')) selId = null;
        inkRedrawMs(); saveSoon();
      }
      function doRedoMs() {
        var pid = msPid(), st = redos[pid] || [];
        if (!st.length) return;
        var o = st.pop();
        opApply(pid, o, false);
        (ops[pid] = ops[pid] || []).push(o);
        inkRedrawMs(); saveSoon();
      }

      /* 形状渲染(吸附 0/45/90) */
      function snap45(a, b) {
        var dx = b[0] - a[0], dy = b[1] - a[1];
        var ang = Math.atan2(dy, dx), d = Math.sqrt(dx * dx + dy * dy);
        var s = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
        return [a[0] + Math.cos(s) * d, a[1] + Math.sin(s) * d];
      }
      function renderShape(ctx, s) {
        var a = s.pts[0], b = s.pts[1] || s.pts[0];
        if (s.shape === 'line' || s.shape === 'arrow') b = snap45(a, b);
        ctx.strokeStyle = s.color; ctx.lineWidth = s.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath();
        if (s.shape === 'line' || s.shape === 'arrow') {
          ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
          if (s.shape === 'arrow') {
            var ang = Math.atan2(b[1] - a[1], b[0] - a[0]), hl = Math.max(10, s.width * 3.5);
            ctx.moveTo(b[0], b[1]);
            ctx.lineTo(b[0] - hl * Math.cos(ang - 0.45), b[1] - hl * Math.sin(ang - 0.45));
            ctx.moveTo(b[0], b[1]);
            ctx.lineTo(b[0] - hl * Math.cos(ang + 0.45), b[1] - hl * Math.sin(ang + 0.45));
          }
        } else if (s.shape === 'rect') {
          ctx.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
        } else if (s.shape === 'ellipse') {
          ctx.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.abs(b[0] - a[0]) / 2, Math.abs(b[1] - a[1]) / 2, 0, 0, Math.PI * 2);
        } else if (s.shape === 'triangle') {
          ctx.moveTo((a[0] + b[0]) / 2, Math.min(a[1], b[1]));
          ctx.lineTo(Math.max(a[0], b[0]), Math.max(a[1], b[1]));
          ctx.lineTo(Math.min(a[0], b[0]), Math.max(a[1], b[1]));
          ctx.closePath();
        }
        ctx.stroke();
      }
      function strokeBBox(s) {
        var xs = [], ys = [];
        if (s.tool === 'text') {
          var w = (s.text || '').length * s.width * 0.62, h = s.width * 1.35;
          xs = [s.pts[0][0], s.pts[0][0] + w]; ys = [s.pts[0][1], s.pts[0][1] + h];
        } else if (s.tool === 'shape') {
          xs = [s.pts[0][0], s.pts[1][0]]; ys = [s.pts[0][1], s.pts[1][1]];
        } else {
          (s.pts || []).forEach(function (p) { xs.push(p[0]); ys.push(p[1]); });
        }
        return { x0: Math.min.apply(null, xs), y0: Math.min.apply(null, ys), x1: Math.max.apply(null, xs), y1: Math.max.apply(null, ys) };
      }
      function inkRedrawMs(preview) {
        ictx.setTransform(1, 0, 0, 1, 0, 0);
        ictx.clearRect(0, 0, ink.width, ink.height);
        ictx.save();
        ictx.scale(ink.width / 1280, ink.height / 720);
        (S.strokes[msPid()] || []).forEach(function (st) {
          ictx.save();
          if (st.tool === 'shape') renderShape(ictx, st);
          else drawStroke(ictx, st);
          ictx.restore();
          if (selId && st.id === selId) {
            var b = strokeBBox(st), pad = 8;
            ictx.save();
            ictx.strokeStyle = '#3b82f6'; ictx.lineWidth = 1.5; ictx.setLineDash([7, 5]);
            ictx.strokeRect(b.x0 - pad, b.y0 - pad, b.x1 - b.x0 + pad * 2, b.y1 - b.y0 + pad * 2);
            ictx.restore();
          }
        });
        if (preview) { ictx.save(); if (preview.tool === 'shape') renderShape(ictx, preview); else drawStroke(ictx, preview); ictx.restore(); }
        ictx.restore();
      }
      function clearInkMs() {
        var pid = msPid(), arr = S.strokes[pid] || [];
        if (!arr.length) return;
        opPush(pid, { op: 'clear', list: arr.slice() });
        S.strokes[pid] = [];
        selId = null;
        inkRedrawMs(); saveSoon();
      }
      function eraseAt(vx, vy) {
        var pid = msPid(), arr = S.strokes[pid] || [];
        for (var i = arr.length - 1; i >= 0; i--) {
          var st = arr[i], hit = false;
          if (st.tool === 'shape' || st.tool === 'text') {
            var b = strokeBBox(st);
            hit = vx >= b.x0 - 10 && vx <= b.x1 + 10 && vy >= b.y0 - 10 && vy <= b.y1 + 10;
          } else {
            hit = (st.pts || []).some(function (pt) { return Math.abs(pt[0] - vx) < 12 + st.width / 2 && Math.abs(pt[1] - vy) < 12 + st.width / 2; });
          }
          if (hit) {
            arr.splice(i, 1);
            opPush(pid, { op: 'del', s: st });
            if (selId === st.id) selId = null;
            inkRedrawMs();
            return;
          }
        }
      }
      function pickAt(vx, vy) {
        var arr = S.strokes[msPid()] || [];
        for (var i = arr.length - 1; i >= 0; i--) {
          var st = arr[i], b = strokeBBox(st), pad = st.tool === 'shape' || st.tool === 'text' ? 10 : 12 + (st.width || 3) / 2;
          var inside = vx >= b.x0 - pad && vx <= b.x1 + pad && vy >= b.y0 - pad && vy <= b.y1 + pad;
          if (inside) return st;
        }
        return null;
      }

      /* 激光笔 */
      var laserOn = false;
      var laserCv = el('canvas', '', 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:6');
      wrap.appendChild(laserCv);
      function laserResize() {
        laserCv.width = Math.round(window.innerWidth * S.dpr);
        laserCv.height = Math.round(window.innerHeight * S.dpr);
      }
      function laserLoop() {
        if (!laserOn) return;
        requestAnimationFrame(laserLoop);
        var ctx = laserCv.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, laserCv.width, laserCv.height);
        var now = Date.now();
        laserDots = laserDots.filter(function (d) { return now - d.t < 650; });
        for (var k = 0; k < laserDots.length; k++) {
          var d = laserDots[k], age = (now - d.t) / 650;
          ctx.beginPath();
          ctx.fillStyle = 'rgba(239,68,68,' + (1 - age * .8) + ')';
          ctx.arc(d.x / 1280 * laserCv.width, d.y / 720 * laserCv.height, (7 - age * 4) * (laserCv.width / 1280), 0, Math.PI * 2);
          ctx.fill();
        }
      }

      /* ---------- 输入 ---------- */
      var textInput = null; /* {ta, vxy} */
      function commitText() {
        if (!textInput) return;
        var txt = textInput.ta.value.trim();
        var v = textInput.vxy;
        textInput.ta.remove();
        textInput = null;
        if (txt) {
          var st = { id: uid(), tool: 'text', color: cfg.text.color, width: cfg.text.size, pts: [v], text: txt };
          (S.strokes[msPid()] = S.strokes[msPid()] || []).push(st);
          opPush(msPid(), { op: 'add', s: st });
          inkRedrawMs();
        }
      }
      ink.addEventListener('pointerdown', function (e) {
        if (tool === 'cursor') return;
        e.preventDefault();
        try { ink.setPointerCapture(e.pointerId); } catch (err) { }
        var v = toVirt(e.clientX, e.clientY);
        if (tool === 'laser') { laserDots.push({ x: v[0], y: v[1], t: Date.now() }); return; }
        if (tool === 'eraser') { eraseAt(v[0], v[1]); return; }
        if (tool === 'text') {
          commitText();
          var ta = el('textarea', '', 'position:absolute;z-index:30;background:rgba(255,255,255,.96);color:#111;border:2px solid #3b82f6;border-radius:8px;padding:6px 10px;outline:none;resize:none;overflow:hidden;line-height:1.3;min-width:80px');
          var sc = window.innerWidth / 1280;
          ta.style.left = (e.clientX) + 'px'; ta.style.top = (e.clientY) + 'px';
          ta.style.font = (cfg.text.size * sc) + 'px ' + FONT_STACK;
          ta.rows = 1;
          wrap.appendChild(ta);
          setTimeout(function () { ta.focus(); }, 30);
          textInput = { ta: ta, vxy: v };
          ta.addEventListener('input', function () { ta.rows = Math.max(1, ta.value.split('\n').length); });
          ta.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); commitText(); }
            else if (ev.key === 'Escape') { textInput.ta.remove(); textInput = null; }
            ev.stopPropagation();
          });
          return;
        }
        if (tool === 'select') {
          var st = pickAt(v[0], v[1]);
          selId = st ? st.id : null;
          if (st) selOff = { st: st, start: v, before: (st.tool === 'text') ? st.pts[0].slice() : (st.tool === 'shape' ? st.pts.map(function (p) { return p.slice(); }) : st.pts.map(function (p) { return p.slice(); })) };
          inkRedrawMs();
          return;
        }
        if (tool === 'shape') {
          drawing = { id: uid(), tool: 'shape', shape: cfg.shape.type, color: cfg.shape.color, width: cfg.shape.width, pts: [v, v] };
          return;
        }
        drawing = { id: uid(), tool: tool, color: tool === 'pen' ? cfg.pen.color : cfg.marker.color,
          width: tool === 'pen' ? cfg.pen.width : cfg.marker.width, pts: [v] };
        S.strokes[msPid()] = S.strokes[msPid()] || [];
        S.strokes[msPid()].push(drawing);
        opPush(msPid(), { op: 'add', s: drawing });
        inkRedrawMs();
      });
      ink.addEventListener('pointermove', function (e) {
        if (tool === 'cursor') return;
        var v = toVirt(e.clientX, e.clientY);
        if (tool === 'laser') { laserDots.push({ x: v[0], y: v[1], t: Date.now() }); return; }
        if (tool === 'eraser') { if (e.buttons || e.pointerType === 'touch') eraseAt(v[0], v[1]); return; }
        if (tool === 'select' && selOff && e.buttons) {
          var st = selOff.st, dx = v[0] - selOff.start[0], dy = v[1] - selOff.start[1];
          if (st.tool === 'text') { st.pts[0] = [selOff.before[0] + dx, selOff.before[1] + dy]; }
          else { st.pts = selOff.before.map(function (p) { return [p[0] + dx, p[1] + dy]; }); }
          inkRedrawMs();
          return;
        }
        if (!drawing) return;
        if (drawing.tool === 'shape') { drawing.pts[1] = v; inkRedrawMs(drawing); return; }
        drawing.pts.push(v);
        inkRedrawMs();
      });
      function endStroke() {
        if (drawing) {
          if (drawing.tool === 'shape') {
            if (Math.abs(drawing.pts[1][0] - drawing.pts[0][0]) + Math.abs(drawing.pts[1][1] - drawing.pts[0][1]) > 12) {
              (S.strokes[msPid()] = S.strokes[msPid()] || []).push(drawing);
              opPush(msPid(), { op: 'add', s: drawing });
            }
            inkRedrawMs();
          }
          drawing = null; saveSoon();
        }
        if (selOff) {
          var st = selOff.st;
          var after = (st.tool === 'text') ? st.pts[0].slice() : st.pts.map(function (p) { return p.slice(); });
          if (JSON.stringify(after) !== JSON.stringify(selOff.before)) {
            opPush(msPid(), { op: 'move', s: st, before: selOff.before, after: after });
          }
          selOff = null;
        }
      }
      ink.addEventListener('pointerup', endStroke);
      ink.addEventListener('pointercancel', endStroke);

      /* ---------- 顶栏(精简) ---------- */
      var top = el('div', '', 'position:absolute;top:14px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:4px;z-index:20;background:rgba(12,12,14,.82);border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:6px 14px;color:rgba(255,255,255,.9);font:13px/1 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);backdrop-filter:blur(6px);user-select:none;white-space:nowrap');
      function tspan(id, title, html) {
        var sp = el('span', '', 'cursor:pointer;padding:4px 9px;border-radius:6px;display:inline-grid;place-items:center');
        sp.id = id; sp.title = title; sp.innerHTML = html;
        top.appendChild(sp); return sp;
      }
      var bExit = tspan('ms-x', '退出放映 (Esc)', '✕');
      bExit.onclick = function () { try { window.close(); } catch (err) { } exitHint.style.display = ''; };
      var bPg = tspan('mspg', '板书页码', '1 / ' + totPages);
      bPg.style.minWidth = '58px'; bPg.style.textAlign = 'center'; bPg.style.fontVariantNumeric = 'tabular-nums';
      var bDot = tspan('msdot', '微软渲染', '●');
      bDot.style.color = '#4ade80'; bDot.style.cursor = 'default';
      top.appendChild(el('span', '', 'width:1px;height:14px;background:rgba(255,255,255,.2)'));
      var bTime = tspan('mstime', '点击重置计时', '00:00');
      bTime.style.fontVariantNumeric = 'tabular-nums';
      bTime.onclick = function () { S.t0 = Date.now(); };
      top.appendChild(el('span', '', 'width:1px;height:14px;background:rgba(255,255,255,.2)'));
      var bFull = tspan('ms-full', '全屏 (F)', icon('full', 16));
      bFull.onclick = function () {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen().catch(function () { });
      };
      var hideTop = 0;
      function wakeTop() {
        top.style.opacity = '1';
        clearTimeout(hideTop);
        hideTop = setTimeout(function () { top.style.opacity = '0'; }, 4000);
      }
      wrap.addEventListener('mousemove', wakeTop);
      wakeTop();
      wrap.appendChild(top);

      /* ---------- 悬浮提示 (v1.25: 补上 toastMs 定义, 修复 v1.23 起 4 处 ReferenceError) ---------- */
      var msToastWrap = el('div', '', 'position:absolute;left:50%;top:62px;transform:translateX(-50%);z-index:52;display:flex;flex-direction:column;align-items:center;gap:6px;pointer-events:none;width:100%');
      wrap.appendChild(msToastWrap);
      function toastMs(msg, dur) {
        var t = el('div', '', 'background:rgba(17,20,26,.94);border:1px solid rgba(255,255,255,.14);color:#e5e7eb;font:13px/1.5 ' + FONT_STACK + ';padding:9px 16px;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.45);opacity:0;transform:translateY(-8px);transition:opacity .3s cubic-bezier(.22,1,.36,1),transform .3s cubic-bezier(.22,1,.36,1);max-width:80vw;text-align:center');
        t.textContent = msg;
        msToastWrap.appendChild(t);
        setTimeout(function () { t.style.opacity = '1'; t.style.transform = 'translateY(0)'; }, 16);
        setTimeout(function () {
          t.style.opacity = '0'; t.style.transform = 'translateY(-8px)';
          setTimeout(function () { t.remove(); }, 340);
        }, dur || 2600);
      }

      /* ---------- 工具栏: 左右两侧竖排(底部完全留给微软, 任意分辨率不遮挡) ----------
         微软自己的 ‹ › 翻页键和页码在屏幕底部中央, 直接点它翻 PPT;
         左栏 ‹ ＋ › 只翻我们的板书页(和 PPT 页数无关) */
      function pill(idName, side) {
        var p = el('nav', '', 'position:absolute;top:50%;transform:translateY(-50%);z-index:30;display:flex;flex-direction:column;align-items:center;gap:3px;padding:10px 8px;background:rgba(255,255,255,.94);backdrop-filter:blur(22px) saturate(1.5);-webkit-backdrop-filter:blur(22px) saturate(1.5);border:1px solid rgba(15,18,24,.10);border-radius:20px;box-shadow:0 6px 18px rgba(11,12,15,.14),0 18px 50px rgba(11,12,15,.20);animation:flaSide .55s cubic-bezier(.22,1,.36,1) both');
        p.id = idName;
        if (side === 'l') p.style.left = '14px'; else p.style.right = '14px';
        wrap.appendChild(p); return p;
      }
      function vbtn(group, id, title, html) {
        var b = el('button', '', 'color:#5a6270');
        b.className = 'vbtn';
        b.id = id; b.title = title; b.innerHTML = html;
        return b;
      }
      function sep() { var i = el('i', '', 'width:24px;height:1px;background:rgba(15,18,24,.12);margin:5px 0;flex-shrink:0'); return i; }
      /* 左栏: 光标(正常模式·点击画面翻PPT) + 七工具 + 撤销/重做 + 板书页 ‹ ＋ › */
      var barL = pill('msbar-l', 'l');
      var TOOLS = [['cursor', '正常模式 · 点击画面翻 PPT (Esc)'], ['select', '选择 / 移动 (1)'], ['pen', '笔 (2)'], ['marker', '荧光笔 (3)'], ['shape', '几何图形 (4)'], ['text', '文本 (5)'], ['laser', '激光笔 (6)'], ['eraser', '橡皮 (7)']];
      var toolBtns = {};
      TOOLS.forEach(function (t) {
        var b = vbtn(t[0], 'msb-' + t[0], t[1], icon(t[0] === 'shape' ? 'shapes' : t[0], 20));
        b.onclick = function () {
          if (t[0] === 'cursor') {           /* 正常模式: 无配置弹窗, 直接切回(点画面=翻PPT) */
            if (tool !== 'cursor') setTool('cursor');
            return;
          }
          if (tool === t[0]) {
            /* 再点一次: 开/关配置弹窗(笔色/粗细/形状/字号/橡皮) */
            if (pop.style.display === 'none' || pop.dataset.tool !== t[0]) { buildPop(); pop.dataset.tool = t[0]; pop.style.display = ''; }
            else pop.style.display = 'none';
          } else setTool(t[0]);
        };
        toolBtns[t[0]] = b;
        barL.appendChild(b);
      });
      toolBtns.cursor.classList.add('on');   /* 初始即正常模式 */
      barL.appendChild(sep());
      barL.appendChild(vbtn('util', 'ms-undo', '撤销板书 (Ctrl+Z)', icon('undo', 20))).onclick = doUndoMs;
      barL.appendChild(vbtn('util', 'ms-redo', '重做板书 (Ctrl+Y)', icon('redo', 20))).onclick = doRedoMs;
      barL.appendChild(sep());
      barL.appendChild(vbtn('page', 'ms-prev', '板书上一页 (←)', icon('chevL', 20))).onclick = function () { prevBoardPage(); };
      barL.appendChild(vbtn('page', 'ms-addpage', '板书加页(独立于 PPT 页数)', icon('plusPage', 20))).onclick = function () { addBoardPage(); };
      barL.appendChild(vbtn('page', 'ms-next', '板书下一页 (→)', icon('chevR', 20))).onclick = function () { nextBoardPage(); };
      /* 右栏: 清空 / 板中板 / 离线 / 黑屏 */
      var barR = pill('msbar-r', 'r');
      barR.style.animationName = 'flaSideR';
      barR.appendChild(vbtn('util', 'ms-clear', '清空本页板书', icon('trash', 20))).onclick = function () { clearInkMs(); };
      barR.appendChild(vbtn('util', 'ms-bnb', '板中板: 独立黑板(独立加页), 再点收起', icon('board', 20))).onclick = function () { toggleBnb(); };
      barR.appendChild(vbtn('util', 'ms-eng', '离线引擎(断网可用)', icon('bolt', 20))).onclick = function () {
        location.href = '/present.html?fid=' + FID + '&token=' + encodeURIComponent(TOKEN);
      };
      barR.appendChild(vbtn('util', 'ms-black', '黑屏 (B)', icon('square', 20))).onclick = function () { blk.style.display = ''; };

      /* ---------- 板书页导航(独立于 PPT: PPT 用屏幕点击/微软底栏翻) ---------- */
      function prevBoardPage() { if (S.msPage > 1) { S.msPage--; inkRedrawMs(); syncPg(); } }
      function nextBoardPage() { if (S.msPage < totPages) { S.msPage++; inkRedrawMs(); syncPg(); } }
      function addBoardPage() {
        S.pages.push({ t: 'ms', n: S.pages.length, pid: 'm' + S.pages.length, bg: 'w' });
        totPages = S.pages.length;
        S.msPage = totPages;
        inkRedrawMs(); syncPg(); saveSoon();
        toastMs('板书已加页: 第 ' + totPages + ' 页 (与 PPT 页数无关)', 3000);
      }

      /* ---------- 工具弹窗(白板同款样式) ---------- */
      var pop = el('div', '', 'position:absolute;left:84px;top:50%;transform:translateY(-50%);z-index:35;display:none;background:rgba(17,20,26,.96);border:1px solid #3a4150;border-radius:16px;padding:14px 16px 10px;box-shadow:0 18px 50px rgba(0,0,0,.5);backdrop-filter:blur(20px);max-width:92vw');
      function swatchRow(colors, cur, onpick, custom) {
        var row = el('div', 'pop-row swatches');
        colors.forEach(function (c) {
          var b = el('button', 'swatch' + (c === cur ? ' on' : ''), '');
          b.style.background = c;
          b.onclick = function () {
            onpick(c);
            Array.prototype.forEach.call(row.querySelectorAll('.swatch'), function (x) { x.classList.remove('on'); });
            b.classList.add('on');
          };
          row.appendChild(b);
        });
        if (custom) {
          var lab = el('label', 'swatch custom', '');
          lab.title = '自定义颜色';
          var ci = el('input'); ci.type = 'color'; ci.value = cur;
          ci.oninput = function () { onpick(ci.value); };
          lab.appendChild(ci);
          row.appendChild(lab);
        }
        return row;
      }
      function sliderRow(label, min, max, val, oninput) {
        var row = el('div', 'pop-row');
        var lb = el('span', 'pop-lb', ''); lb.textContent = label;
        var rng = el('input'); rng.type = 'range'; rng.min = min; rng.max = max; rng.value = val;
        rng.style.cssText = 'flex:1;min-width:100px;accent-color:#e5e7eb';
        var valB = el('b', 'pop-val', ''); valB.textContent = val;
        rng.oninput = function () { valB.textContent = rng.value; oninput(+rng.value); };
        row.appendChild(lb); row.appendChild(rng); row.appendChild(valB);
        return row;
      }
      function buildPop() {
        pop.innerHTML = '';
        pop.style.display = '';
        if (tool === 'pen') {
          pop.appendChild(swatchRow(PEN_COLORS, cfg.pen.color, function (c) { cfg.pen.color = c; }, true));
          pop.appendChild(sliderRow('粗细', 1, 12, cfg.pen.width, function (v) { cfg.pen.width = v; }));
        } else if (tool === 'marker') {
          pop.appendChild(swatchRow(MARKER_COLORS, cfg.marker.color, function (c) { cfg.marker.color = c; }, true));
          pop.appendChild(sliderRow('粗细', 6, 30, cfg.marker.width, function (v) { cfg.marker.width = v; }));
        } else if (tool === 'shape') {
          var srow = el('div', 'pop-row');
          SHAPE_LIST.forEach(function (sh) {
            var b = el('button', 'swatch' + (cfg.shape.type === sh[0] ? ' on' : ''), '');
            b.title = sh[1]; b.innerHTML = SHAPE_MINI[sh[0]];
            b.style.cssText = 'width:34px;height:34px;border-radius:9px;border:1px solid #4b5563;background:rgba(255,255,255,.05);color:#e5e7eb;display:inline-grid;place-items:center;cursor:pointer;padding:0';
            if (cfg.shape.type === sh[0]) b.style.borderColor = '#fff';
            b.onclick = function () {
              cfg.shape.type = sh[0];
              Array.prototype.forEach.call(srow.children, function (x) { x.style.borderColor = '#4b5563'; });
              b.style.borderColor = '#fff';
            };
            srow.appendChild(b);
          });
          pop.appendChild(srow);
          pop.appendChild(swatchRow(SHAPE_COLORS, cfg.shape.color, function (c) { cfg.shape.color = c; }, true));
          pop.appendChild(sliderRow('粗细', 1, 12, cfg.shape.width, function (v) { cfg.shape.width = v; }));
        } else if (tool === 'text') {
          pop.appendChild(swatchRow(TEXT_COLORS, cfg.text.color, function (c) { cfg.text.color = c; }, true));
          pop.appendChild(sliderRow('字号', 12, 72, cfg.text.size, function (v) { cfg.text.size = v; }));
          var hint = el('p', '', 'font:11px inherit;color:#9ca3af;margin:4px 0 0');
          hint.textContent = '点击画面输入文字，Enter 确认';
          pop.appendChild(hint);
        } else if (tool === 'eraser') {
          pop.appendChild(sliderRow('橡皮大小', 6, 90, cfg.eraser.width, function (v) { cfg.eraser.width = v; }));
          var eh = el('p', '', 'font:11px inherit;color:#9ca3af;margin:4px 0 0');
          eh.textContent = '划过即擦除整条笔迹';
          pop.appendChild(eh);
        }
        var show = tool === 'pen' || tool === 'marker' || tool === 'shape' || tool === 'text' || tool === 'eraser';
        pop.style.display = show ? 'block' : 'none';
      }
      wrap.appendChild(pop);
      wrap.addEventListener('pointerdown', function (e) {
        if (pop.style.display !== 'none' && !pop.contains(e.target)) pop.style.display = 'none';
      }, true);

      function setTool(t) {
        var prev = tool;
        commitText();
        tool = t;
        laserOn = t === 'laser';
        if (laserOn) laserLoop(); else { var lc = laserCv.getContext('2d'); lc.setTransform(1, 0, 0, 1, 0, 0); lc.clearRect(0, 0, laserCv.width, laserCv.height); }
        if (t !== 'select') { selId = null; inkRedrawMs(); }
        ink.style.pointerEvents = (t === 'cursor') ? 'none' : 'auto';
        ink.style.cursor = t === 'eraser' ? 'cell' : (t === 'select' ? 'default' : (t === 'cursor' ? '' : 'crosshair'));
        hideLd();
        TOOLS.forEach(function (tt) {
          if (t === tt[0]) toolBtns[tt[0]].classList.add('on'); else toolBtns[tt[0]].classList.remove('on');
        });
        pop.style.display = 'none';   /* 切工具不弹窗: 配置窗只在"再点一次同工具"时出现 */
        if (t !== 'cursor') wakeTop();
        if (t === 'cursor' && prev !== 'cursor') toastMs('正常模式 · 点击画面即可翻 PPT', 2200);
      }

      function syncPg() { bPg.textContent = S.msPage + ' / ' + totPages; }

      /* ---------- 板中板: 独立黑板(自己的页数, 与 PPT 页完全独立) ---------- */
      var bbN = 1, bbCur = 0, bbOpen = false, bbOps = {}, bbRedos = {};
      (function () {
        var m = 0;
        for (var k in S.strokes) { var mm = /^bb(\d+)$/.exec(k); if (mm) m = Math.max(m, +mm[1] + 1); }
        var bbSaved = (S.bbN && typeof S.bbN === 'object' && S.bbN.n) ? S.bbN.n : (typeof S.bbN === 'number' ? S.bbN : 0);
        if (bbSaved > m) m = bbSaved;
        bbN = Math.max(1, m); S.bbN = bbN;
      })();
      function bbPid() { return 'bb' + bbCur; }
      var bnb = el('div', '', 'position:absolute;left:50%;top:0;transform:translate(-50%,-104%);width:min(94vw,1500px);height:66vh;z-index:38;background:#141922;border:1px solid #3a4150;border-top:none;border-radius:0 0 26px 26px;box-shadow:0 34px 90px rgba(0,0,0,.55);transition:transform .5s cubic-bezier(.22,1,.36,1);display:flex;flex-direction:column');
      bnb.id = 'msbnb';
      var bnbBar = el('div', '', 'display:flex;align-items:center;gap:6px;padding:8px 14px;border-bottom:1px solid #2a3038;color:#d5d9e0;font:12px ' + FONT_STACK + ';flex-shrink:0');
      var bnbTitle = el('span', '', 'font-weight:700;color:#e8eaee;letter-spacing:.5px');
      bnbTitle.textContent = '\u25a4 板中板';
      function bbBtn(id, title, html) {
        var b = el('button', '', 'border:none;background:transparent;color:#aab2bf;border-radius:9px;min-width:32px;height:32px;padding:0 8px;cursor:pointer;display:inline-grid;place-items:center;font:12px ' + FONT_STACK + ';transition:all .15s');
        b.id = id; b.title = title; b.innerHTML = html;
        b.onmouseenter = function () { b.style.background = 'rgba(255,255,255,.09)'; b.style.color = '#fff'; };
        b.onmouseleave = function () { b.style.background = 'transparent'; b.style.color = '#aab2bf'; };
        return b;
      }
      var bbPrev = bbBtn('bnb-prev', '板中板上一页', '‹');
      var bbPg = el('span', '', 'min-width:56px;text-align:center;color:#e8eaee;font-weight:600;font-variant-numeric:tabular-nums');
      bbPg.id = 'bnb-pg';
      var bbNext = bbBtn('bnb-next', '板中板下一页', '›');
      var bbAdd = bbBtn('bnb-add', '板中板加页(独立于 PPT 页数)', '＋ 加页');
      var bbUndoB = bbBtn('bnb-undo', '撤销板中板 (Ctrl+Z)', icon('undo', 16));
      var bbClearB = bbBtn('bnb-clear', '清空板中板本页', icon('trash', 16));
      var bbHide = bbBtn('bnb-hide', '收起(再点工具栏"板中板"可再次放下)', '✕ 收起');
      bbPrev.onclick = function () { if (bbCur > 0) { bbCur--; bbRedraw(); } };
      bbNext.onclick = function () { if (bbCur < bbN - 1) { bbCur++; bbRedraw(); } };
      bbAdd.onclick = function () { bbN++; S.bbN = bbN; bbCur = bbN - 1; bbRedraw(); saveSoon(); toastMs('板中板已加页: 第 ' + bbN + ' 页(独立于 PPT)'); };
      bbUndoB.onclick = function () { doBbUndo(); };
      bbClearB.onclick = function () {
        var pid = bbPid();
        if ((S.strokes[pid] || []).length) {
          bbOps[pid] = bbOps[pid] || []; bbRedos[pid] = [];
          bbOps[pid].push({ op: 'clear', list: S.strokes[pid].slice() });
          S.strokes[pid] = [];
          bbRedraw(); saveSoon();
        }
      };
      bbHide.onclick = function () { toggleBnb(); };
      bnbBar.appendChild(bnbTitle);
      bnbBar.appendChild(el('span', '', 'width:1px;height:18px;background:#2a3038;margin:0 4px'));
      bnbBar.appendChild(bbPrev); bnbBar.appendChild(bbPg); bnbBar.appendChild(bbNext);
      bnbBar.appendChild(bbAdd);
      bnbBar.appendChild(el('span', '', 'width:1px;height:18px;background:#2a3038;margin:0 4px'));
      bnbBar.appendChild(bbUndoB); bnbBar.appendChild(bbClearB);
      bnbBar.appendChild(el('span', '', 'flex:1'));
      bnbBar.appendChild(bbHide);
      var bbWrap = el('div', '', 'flex:1;position:relative;overflow:hidden');
      var bbCv = el('canvas', '', 'position:absolute;left:0;top:0;width:100%;height:100%;touch-action:none;cursor:crosshair');
      bbCv.id = 'bnb-cv';
      bbWrap.appendChild(bbCv);
      bnb.appendChild(bnbBar); bnb.appendChild(bbWrap);
      wrap.appendChild(bnb);
      function bbGeom() {
        var r = bbCv.getBoundingClientRect();
        var k = Math.min(r.width / 1280, r.height / 720);
        return { k: k, ox: (r.width - 1280 * k) / 2, oy: (r.height - 720 * k) / 2 };
      }
      function bbRedraw() {
        bbPg.textContent = (bbCur + 1) + ' / ' + bbN;
        var r = bbCv.getBoundingClientRect();
        if (r.width < 2) return;
        if (bbCv.width !== Math.round(r.width) || bbCv.height !== Math.round(r.height)) { bbCv.width = Math.round(r.width); bbCv.height = Math.round(r.height); }
        var g = bbCv.getContext('2d');
        g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, bbCv.width, bbCv.height);
        var gm = bbGeom();
        g.save(); g.translate(gm.ox, gm.oy); g.scale(gm.k, gm.k);
        (S.strokes[bbPid()] || []).forEach(function (st) { g.save(); drawStroke(g, st); g.restore(); });
        g.restore();
      }
      function doBbUndo() {
        var pid = bbPid(); bbOps[pid] = bbOps[pid] || [];
        var op = bbOps[pid].pop();
        if (!op) { toastMs('板中板没有可撤销的操作'); return; }
        bbRedos[pid] = bbRedos[pid] || [];
        var arr = S.strokes[pid] = S.strokes[pid] || [];
        if (op.op === 'add') { var i = arr.indexOf(op.s); if (i >= 0) arr.splice(i, 1); }
        else if (op.op === 'del') { arr.push(op.s); }
        else if (op.op === 'clear') { S.strokes[pid] = op.list.slice(); }
        bbRedos[pid].push(op);
        bbRedraw(); saveSoon();
      }
      function doBbRedo() {
        var pid = bbPid(); bbRedos[pid] = bbRedos[pid] || [];
        var op = bbRedos[pid].pop();
        if (!op) return;
        bbOps[pid].push(op);
        var arr = S.strokes[pid] = S.strokes[pid] || [];
        if (op.op === 'add') arr.push(op.s);
        else if (op.op === 'del') { var i = arr.indexOf(op.s); if (i >= 0) arr.splice(i, 1); }
        else if (op.op === 'clear') { S.strokes[pid] = []; }
        bbRedraw(); saveSoon();
      }
      var bbDrawing = null;
      function bbPt(e) {
        var r = bbCv.getBoundingClientRect();
        var gm = bbGeom();
        return [(e.clientX - r.left - gm.ox) / gm.k, (e.clientY - r.top - gm.oy) / gm.k];
      }
      function bbErase(p) {
        var pid = bbPid(), arr = S.strokes[pid] || [];
        for (var i = arr.length - 1; i >= 0; i--) {
          var st = arr[i], hit = false;
          for (var j = 0; j < st.pts.length; j++) {
            if (Math.abs(st.pts[j][0] - p[0]) < 14 && Math.abs(st.pts[j][1] - p[1]) < 14) { hit = true; break; }
          }
          if (hit) {
            arr.splice(i, 1);
            bbOps[pid] = bbOps[pid] || []; bbRedos[pid] = [];
            bbOps[pid].push({ op: 'del', s: st });
            saveSoon(); bbRedraw();
          }
        }
      }
      bbCv.addEventListener('pointerdown', function (e) {
        e.preventDefault(); e.stopPropagation();
        if (bbCv.setPointerCapture) { try { bbCv.setPointerCapture(e.pointerId); } catch (err) { } }
        var p0 = bbPt(e);
        if (tool === 'eraser') { bbErase(p0); return; }
        var tt = (tool === 'marker' || tool === 'laser') ? tool : 'pen';
        bbDrawing = { tool: tt, color: cfg.color, width: cfg.width, pts: [p0] };
        bbRedraw();
      });
      bbCv.addEventListener('pointermove', function (e) {
        if (tool === 'eraser') { if (e.buttons || e.pointerType === 'touch') bbErase(bbPt(e)); return; }
        if (!bbDrawing) return;
        var p = bbPt(e);
        var last = bbDrawing.pts[bbDrawing.pts.length - 1];
        if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 1.2) return;
        bbDrawing.pts.push(p);
        bbRedraw();
      });
      function bbEnd() {
        if (!bbDrawing) return;
        var pid = bbPid();
        if (bbDrawing.pts.length > 1) {
          (S.strokes[pid] = S.strokes[pid] || []).push(bbDrawing);
          bbOps[pid] = bbOps[pid] || []; bbRedos[pid] = [];
          bbOps[pid].push({ op: 'add', s: bbDrawing });
          if (bbOps[pid].length > 200) bbOps[pid].shift();
          saveSoon();
        }
        bbDrawing = null; bbRedraw();
      }
      bbCv.addEventListener('pointerup', bbEnd);
      bbCv.addEventListener('pointercancel', bbEnd);
      function toggleBnb() {
        bbOpen = !bbOpen;
        bnb.style.transform = bbOpen ? 'translate(-50%,0)' : 'translate(-50%,-104%)';
        if (bbOpen) setTimeout(bbRedraw, 80);
        var ab = document.getElementById('ms-bnb');
        if (ab) { if (bbOpen) ab.classList.add('on'); else ab.classList.remove('on'); }
      }
      window.addEventListener('resize', function () { if (bbOpen) bbRedraw(); });

      /* ---------- 黑屏/退出/加载 ---------- */
      var blk = el('div', '', 'position:absolute;inset:0;background:#000;display:none;z-index:40');
      blk.onclick = function () { blk.style.display = 'none'; };
      wrap.appendChild(blk);
      var exitHint = el('div', '', 'position:absolute;left:50%;top:38%;transform:translate(-50%,-50%);display:none;z-index:60;background:rgba(17,20,25,.96);border:1px solid #3a4150;border-radius:14px;padding:16px 24px;color:#e5e7eb;font:14px ' + FONT_STACK);
      exitHint.textContent = '可直接关闭此标签页退出放映';
      wrap.appendChild(exitHint);
      var warn = sl.ms_ok ? '' :
        '<div style="margin-top:10px;color:#fbbf24;font-size:12px">⚠ 直链(' + sl.direct + ')疑似不符合微软要求(需域名+80/443), 请在管理后台设置公开访问地址</div>';
      var ld = el('div', '', 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);color:#e5e7eb;font:14px/1.9 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;text-align:center;z-index:50;background:rgba(0,0,0,.82);padding:22px 32px;border-radius:14px;max-width:84%');
      ld.id = 'msld';
      ld.innerHTML = '微软服务器正在抓取课件（首次约 30–60 秒）…<br>' +
        '<span style="font-size:12px;color:#9ca3af">加载完成后: 点画面推进动画 · ‹ › 翻页 · 工具栏板书</span>' + warn;
      function hideLd() { ld.style.display = 'none'; }
      fr.onload = function () { setTimeout(hideLd, 4000); };
      setTimeout(function () {
        toastMs('PPT: 点画面前进 · 底部中央是微软翻页键(可后退) · 左右两侧是板书工具 · 左栏 ‹＋› 翻板书页', 9000);
      }, 2500);
      setTimeout(hideLd, 90000);
      wrap.appendChild(ld);

      /* ---------- 键盘 ---------- */
      var KEY_TOOL = { '1': 'select', '2': 'pen', '3': 'marker', '4': 'shape', '5': 'text', '6': 'laser', '7': 'eraser' };
      document.addEventListener('keydown', function (e) {   /* capture: 抢在全局翻页键之前 */
        var kk = e.key.toLowerCase();
        if (!e.ctrlKey && !e.metaKey && !e.altKey) {
          if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); prevBoardPage(); return; }
          if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); nextBoardPage(); return; }
        }
        void kk;
        if (textInput) return;
        var k = e.key.toLowerCase();
        if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); if (bbOpen) doBbUndo(); else doUndoMs(); return; }
        if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); if (bbOpen) doBbRedo(); else doRedoMs(); return; }
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (KEY_TOOL[k]) setTool(tool === KEY_TOOL[k] ? 'cursor' : KEY_TOOL[k]);
        else if (k === 'p') setTool(tool === 'pen' ? 'cursor' : 'pen');
        else if (k === 'l') setTool(tool === 'laser' ? 'cursor' : 'laser');
        else if (k === 'e') setTool('eraser');
        else if (k === 'b') blk.style.display = blk.style.display === 'none' ? '' : 'none';
        else if (k === 'f') bFull.onclick();
        else if (k === 'delete' || k === 'backspace') {
          if (selId) {
            var arr = S.strokes[msPid()] || [];
            for (var i = 0; i < arr.length; i++) {
              if (arr[i].id === selId) {
                var st = arr.splice(i, 1)[0];
                opPush(msPid(), { op: 'del', s: st });
                selId = null; inkRedrawMs(); saveSoon();
                break;
              }
            }
          }
        }
        else if (k === 'escape') { if (blk.style.display !== 'none') blk.style.display = 'none'; else setTool('cursor'); }
      }, true);

      /* ---------- 计时/布局 ---------- */
      setInterval(function () {
        var sec = Math.floor((Date.now() - S.t0) / 1000);
        var mm = Math.floor(sec / 60), ss = sec % 60;
        bTime.textContent = (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
      }, 1000);
      function layoutMs() {
        canvasSize(); laserResize();
        if (bbOpen) bbRedraw();
      }
      window.addEventListener('resize', layoutMs);
      layoutMs(); syncPg();
      document.body.appendChild(wrap);
      setInterval(function () { if (S.dirty) saveNow(); }, 15000);
    });
  }

  function openPdf() {
    return loadScript('/lib/pdfjs/pdf.min.js').then(function () {
      var lib = window.pdfjsLib;
      if (!lib) throw new Error('PDF 组件加载失败, 请强制刷新(Ctrl+F5)');
      lib.GlobalWorkerOptions.workerSrc = '/lib/pdfjs/pdf.worker.min.js';
      S.pdfjs = lib;
      return lib.getDocument({
        url: '/api/files/' + FID + '/pdf',
        httpHeaders: AUTH
      }).promise.catch(function (e) {   /* v1.26: 友好化 pdf.js 的原始报错 */
        var m = String((e && e.message) || e || '');
        if (m.indexOf('400') >= 0) throw new Error('该文件没有可放映的 PDF (图片/音视频请直接打开, Office 需转换完成)');
        if (m.indexOf('409') >= 0) throw new Error('文档仍在转换中, 请稍后再试');
        if (m.indexOf('403') >= 0) throw new Error('无权访问该文件');
        if (m.indexOf('404') >= 0) throw new Error('文件不存在或已删除');
        throw new Error('PDF 加载失败: ' + m.slice(0, 120));
      });
    }).then(function (doc) { S.doc = doc; return doc.numPages; });
  }

  function ensureBg() {
    if (S.bgDoc) return Promise.resolve(S.bgDoc);
    if (S.bgFailed) return Promise.resolve(null);
    return S.pdfjs.getDocument({
      url: '/api/files/' + FID + '/bgpdf',
      httpHeaders: AUTH
    }).promise.then(function (d) {
      if (d.numPages !== S.doc.numPages) throw new Error('bg pages mismatch');
      S.bgDoc = d; return d;
    }).catch(function () { S.bgFailed = true; return null; });
  }

  function prefetchImgs() {
    if (!S.manifest) return Promise.resolve();
    var jobs = [];
    S.manifest.pages.forEach(function (p) {
      (p.elements || []).forEach(function (e) {
        if (e.kind === 'pic' && e.img && !S.imgMap[e.img]) {
          jobs.push(bget('/api/files/' + FID + '/anim-media/' + e.img).then(function (b) {
            S.imgMap[e.img] = URL.createObjectURL(b);
          }).catch(function () { }));
        }
        if (e.kind === 'table') {
          (e.rows || []).forEach(function (r) {
            (r.cells || []).forEach(function (c) {
              if (c.img && !S.imgMap[c.img]) {
                jobs.push(bget('/api/files/' + FID + '/anim-media/' + c.img).then(function (b) {
                  S.imgMap[c.img] = URL.createObjectURL(b);
                }).catch(function () { }));
              }
            });
          });
        }
      });
    });
    return Promise.all(jobs);
  }

  /* ---------- UI ---------- */
  function buildUI() {
    document.body.innerHTML =
      '<div id="pwrap">' +
      '<div id="pstage"></div>' +
      '<div id="pbar"><i id="pbarin"></i></div>' +
      '<div id="ptop">' +
      '<span id="pexit" title="退出 (Esc)">✕</span>' +
      '<span id="ppg">1 / 1</span>' +
      '<span id="pmode" title="\u6e32\u67d3\u6a21\u5f0f">\u25cf</span>' +
      '<span class="pt-sep"></span>' +
      '<span id="ptime" title="点击重置计时">00:00</span>' +
      '<span class="pt-sep"></span>' +
      '<span id="pbtn-prev" title="上一页 (←)">‹</span>' +
      '<span id="pbtn-next" title="下一步/下一页 (空格)">›</span>' +
      '<span class="pt-sep"></span>' +
      '<span id="pbtn-pen" title="板书 (P)">笔</span>' +
      '<span id="pbtn-laser" title="激光笔 (L)">⦿</span>' +
      '<span id="pbtn-cmp" title="对照原版静态页 (S)">对照</span>' +
      '<span id="pbtn-full" title="全屏 (F)">⛶</span>' +
      '</div>' +
      '<div id="ptools" class="hidden">' +
      '<span class="ptl" data-c="#111111" data-w="3" title="细·黑"></span>' +
      '<span class="ptl" data-c="#111111" data-w="6" title="粗·黑"></span>' +
      '<span class="ptl" data-c="#ef4444" data-w="4" title="红"></span>' +
      '<span class="ptl" data-c="#facc15" data-w="4" title="黄"></span>' +
      '<span class="ptl" data-c="#ffffff" data-w="4" title="白"></span>' +
      '<span class="pt-sep"></span>' +
      '<span id="ptl-marker" title="荧光笔">荧光</span>' +
      '<span id="ptl-eraser" title="橡皮(对象)">擦</span>' +
      '<span id="ptl-clear" title="清空本页板书">清空</span>' +
      '<span id="ptl-off" title="收起 (P)">✓</span>' +
      '</div>' +
      '<div id="phint">点击 / 空格：下一步 · P：板书 · S：对照原版 · B：黑屏</div>' +
      '<div id="pblack"></div>' +
      '<div id="plaser"></div>' +
      '</div>';
    document.getElementById('pexit').onclick = exitPresent;
    document.getElementById('pbtn-prev').onclick = function (e) { e.stopPropagation(); prevPage(); };
    document.getElementById('pbtn-next').onclick = function (e) { e.stopPropagation(); advance(); };
    document.getElementById('pbtn-pen').onclick = function (e) { e.stopPropagation(); toggleTools(); };
    document.getElementById('pbtn-laser').onclick = function (e) { e.stopPropagation(); setTool(S.tool === 'laser' ? 'cursor' : 'laser'); };
    document.getElementById('pbtn-cmp').onclick = function (e) { e.stopPropagation(); toggleCompare(); };
    document.getElementById('pbtn-full').onclick = function (e) { e.stopPropagation(); toggleFull(); };
    document.getElementById('ptime').onclick = function (e) { e.stopPropagation(); S.t0 = Date.now(); };
    var ts = document.getElementById('ptools');
    Array.prototype.forEach.call(ts.querySelectorAll('.ptl'), function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        S.pen.color = b.getAttribute('data-c'); S.pen.width = parseInt(b.getAttribute('data-w'), 10);
        setTool('pen');
        Array.prototype.forEach.call(ts.querySelectorAll('.ptl'), function (x) { x.className = 'ptl'; });
        b.className = 'ptl on';
      };
    });
    document.getElementById('ptl-marker').onclick = function (e) { e.stopPropagation(); setTool('marker'); };
    document.getElementById('ptl-eraser').onclick = function (e) { e.stopPropagation(); setTool('eraser'); };
    document.getElementById('ptl-clear').onclick = function (e) {
      e.stopPropagation(); delete S.strokes[curPage().pid]; inkRedraw(); saveSoon();
    };
    document.getElementById('ptl-off').onclick = function (e) { e.stopPropagation(); setTool('cursor'); };

    document.getElementById('pwrap').addEventListener('click', onStageClick);
    document.getElementById('pstage').addEventListener('pointerdown', onDown);
    document.getElementById('pstage').addEventListener('pointermove', onMove);
    document.getElementById('pstage').addEventListener('pointerup', onUp);
    document.getElementById('pstage').addEventListener('pointercancel', onUp);
    window.addEventListener('keydown', onKey);
    var rzT = 0;
    window.addEventListener('resize', function () {
      clearTimeout(rzT);
      rzT = setTimeout(function () {
        if (S.cur < 0) return;
        var st = stageSize();
        if (st.w === S.lastW && st.h === S.lastH) return;
        showPage(S.cur);
      }, 160);
    });
    document.addEventListener('pointermove', wakeUI);
    window.addEventListener('beforeunload', flushSave);

    setInterval(function () {
      var ptEl = document.getElementById('ptime');
      if (S.timerOn && ptEl) ptEl.textContent = fmtT(Math.floor((Date.now() - S.t0) / 1000));
    }, 1000);
    setTimeout(function () { var h = document.getElementById('phint'); if (h) h.classList.add('off'); }, 4200);
    setModeDot();
    wakeUI();
  }

  function exitPresent() {
    flushSave();
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen || function () { }).call(document);
    }
    if (window.history.length > 1) window.history.back(); else window.close();
  }
  function toggleFull() {
    var d = document.documentElement;
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen || function () { }).call(document);
    } else {
      var fn = d.requestFullscreen || d.webkitRequestFullscreen;
      if (fn) fn.call(d);
    }
  }
  function toggleTools() {
    var t = document.getElementById('ptools');
    t.classList.toggle('hidden');
    if (!t.classList.contains('hidden') && S.tool === 'cursor') setTool('pen');
  }
  function setTool(t) {
    S.tool = t;
    document.getElementById('ptools').classList.toggle('hidden', t === 'cursor' || t === 'laser');
    var pen = document.getElementById('pbtn-pen');
    if (pen) pen.classList.toggle('on', t !== 'cursor' && t !== 'laser');
    var lz = document.getElementById('pbtn-laser');
    if (lz) lz.classList.toggle('on', t === 'laser');
    var st = document.getElementById('pstage');
    st.style.cursor = t === 'eraser' ? 'cell' : (t === 'cursor' ? 'default' : 'crosshair');
    var dot = document.getElementById('plaser');
    if (dot) dot.style.display = t === 'laser' ? 'block' : 'none';
  }
  function toggleCompare() {
    S.compare = !S.compare;
    document.getElementById('pbtn-cmp').classList.toggle('on', S.compare);
    showPage(S.cur);
  }
  function wakeUI() {
    var top = document.getElementById('ptop');
    if (top) top.classList.remove('idle');
    var bar = document.getElementById('pbar');
    if (bar) bar.classList.remove('idle');
    clearTimeout(S.hideT);
    S.hideT = setTimeout(function () {
      if (S.tool === 'cursor') {
        var t = document.getElementById('ptop'); if (t) t.classList.add('idle');
        var b = document.getElementById('pbar'); if (b) b.classList.add('idle');
      }
    }, 2600);
  }

  /* ---------- 页面呈现 ---------- */
  function stageSize() {
    return { w: window.innerWidth, h: window.innerHeight };
  }

  function showPage(i) {
    if (i < 0 || i >= S.pages.length) return;
    flushAuto();
    flushSave();
    var p = S.pages[i];
    S.cur = i;
    var pw = p.w || 1280, ph = p.h || 720;
    var old = S.boxEl;
    var mySeq = ++S.seq;

    var box = el('div', 'ppage');
    box.style.width = '0px'; box.style.height = '0px';
    document.getElementById('pstage').appendChild(box);
    S.boxEl = box;

    var canvas = el('canvas', 'pbg');
    box.appendChild(canvas);
    var layer = el('div', 'pelayer');
    box.appendChild(layer);
    var ink = el('canvas', 'pink');
    box.appendChild(ink);

    S.ink = ink; S.ictx = ink.getContext('2d');
    S.pageEls = []; S.playQueue = []; S.pi = 0;

    var render;
    if (p.t === 'pdf') {
      render = renderPdfPage(p, canvas, box, layer, mySeq);
    } else if (p.t === 'blank') {
      render = renderBlankPage(p, canvas, box, layer);
    } else if (p.t === 'image') {
      render = renderImagePage(p, canvas, box);
    } else if (p.t === 'media') {
      render = renderMediaPage(p, canvas, box);
    } else {
      render = renderStubPage(p, canvas, box, layer);
    }
    render.then(function () {
      if (mySeq !== S.seq) { if (box.parentNode) box.parentNode.removeChild(box); return; }
      layoutInk(p);
      inkRedraw();
      transSwap(old, box, p.t === 'pdf' ? mPage(p.n) : null);
      document.getElementById('ppg').textContent = (i + 1) + ' / ' + S.pages.length;
      document.getElementById('pbarin').style.width = ((i + 1) / S.pages.length * 100) + '%';
      playAuto();
      setModeDot();
    }).catch(function (e) {
      if (mySeq !== S.seq) { if (box.parentNode) box.parentNode.removeChild(box); return; }
      box.innerHTML = '<div class="perr" style="display:flex">' + (e.message || '页面渲染失败') + '</div>';
      transSwap(old, box, null);
    });
  }

  function applyBox(pw, ph) {
    var st = stageSize(), ar = pw / ph;
    var w = st.w, h = st.h;
    if (w / h > ar) w = h * ar; else h = w / ar;
    S.box = { w: Math.round(w), h: Math.round(h) };
    S.lastW = st.w; S.lastH = st.h;
    S.boxEl.style.width = S.box.w + 'px';
    S.boxEl.style.height = S.box.h + 'px';
    return S.box;
  }

  function renderPdfPage(p, canvas, box, layer, mySeq) {
    var n = p.n || 0, mp = mPage(n);
    var useBg = mp && mp.mode === 'elements' && !S.compare && !mp.bgfail && !S.bgFailed;
    var docP = useBg ? ensureBg() : Promise.resolve(S.doc);
    return docP.then(function (doc) {
      if (mySeq !== S.seq) throw { stale: true };
      return (doc || S.doc).getPage(n + 1);
    }).then(function (page) {
      if (mySeq !== S.seq) throw { stale: true };
      var vp = page.getViewport({ scale: 1 });
      p.w = vp.width; p.h = vp.height;
      applyBox(p.w, p.h);
      var cssScale = S.box.w / p.w;
      var vp2 = page.getViewport({ scale: cssScale });
      S.dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(vp2.width * S.dpr);
      canvas.height = Math.round(vp2.height * S.dpr);
      canvas.style.width = S.box.w + 'px';
      canvas.style.height = S.box.h + 'px';
      var ctx = canvas.getContext('2d');
      return page.render({
        canvasContext: ctx, viewport: vp2,
        transform: [S.dpr, 0, 0, S.dpr, 0, 0]
      }).promise;
    }).then(function () {
      if (mySeq !== S.seq) throw { stale: true };
      if (useBg) return buildElements(mp, layer, p);
    });
  }

  function renderBlankPage(p, canvas, box, layer) {
    p.w = p.w || 1280; p.h = p.h || 720;
    applyBox(p.w, p.h);
    S.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(S.box.w * S.dpr);
    canvas.height = Math.round(S.box.h * S.dpr);
    canvas.style.width = S.box.w + 'px';
    canvas.style.height = S.box.h + 'px';
    var ctx = canvas.getContext('2d');
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    ctx.fillStyle = BLANK_BG[p.bg] || BLANK_BG.w;
    ctx.fillRect(0, 0, S.box.w, S.box.h);
    return Promise.resolve();
  }

  /* v1.26: 图片页 — 原生 <img> 渲染(清晰且无 canvas 尺寸上限问题) */
  function renderImagePage(p, canvas, box) {
    canvas.style.display = 'none';
    var img = el('img', 'pimg');
    img.alt = '';
    return bget('/api/files/' + FID + '/raw').then(function (blob) {
      return new Promise(function (res, rej) {
        var url = URL.createObjectURL(blob);
        img.onload = function () {
          p.w = img.naturalWidth || 1280; p.h = img.naturalHeight || 720;
          applyBox(p.w, p.h);
          img.style.width = S.box.w + 'px';
          img.style.height = S.box.h + 'px';
          res();
        };
        img.onerror = function () { rej(new Error('图片加载失败')); };
        img.src = url;
      });
    }).then(function () {
      box.insertBefore(img, box.firstChild);
      return;
    });
  }

  /* v1.26: 音视频页 — 原生控件 + Range 流式(自动用服务端转码后的 mp4) */
  function renderMediaPage(p, canvas, box) {
    canvas.style.display = 'none';
    var src = '/api/files/' + FID + '/raw?token=' + encodeURIComponent(TOKEN);
    var isVideo = S.meta.kind === 'video';
    return new Promise(function (res) {
      if (isVideo) {
        var v = el('video', 'pmedia');
        v.controls = true; v.playsInline = true; v.preload = 'metadata';
        v.src = src;
        v.addEventListener('loadedmetadata', function () {
          p.w = v.videoWidth || 1280; p.h = v.videoHeight || 720;
          applyBox(p.w, p.h);
          v.style.width = S.box.w + 'px';
          v.style.height = S.box.h + 'px';
          res();
        });
        v.addEventListener('error', function () {
          p.w = 1280; p.h = 720; applyBox(p.w, p.h);
          res();  /* 仍显示播放器(浏览器自带"无法播放"提示), 不整页报错 */
        });
        /* 点击播放器不触发翻页 */
        v.addEventListener('click', function (e) { e.stopPropagation(); });
        box.insertBefore(v, box.firstChild);
      } else {
        p.w = 1280; p.h = 720;
        applyBox(p.w, p.h);
        var w = el('div', 'paudio');
        w.innerHTML = '<div class="paudio-ico">♪</div>';
        var a = el('audio');
        a.controls = true; a.preload = 'metadata'; a.src = src;
        w.appendChild(a);
        w.addEventListener('click', function (e) { e.stopPropagation(); });
        box.insertBefore(w, box.firstChild);
        res();
      }
    });
  }

  function renderStubPage(p, canvas, box, layer) {
    p.w = 1280; p.h = 720;
    applyBox(p.w, p.h);
    S.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(S.box.w * S.dpr);
    canvas.height = Math.round(S.box.h * S.dpr);
    canvas.style.width = S.box.w + 'px';
    canvas.style.height = S.box.h + 'px';
    var ctx = canvas.getContext('2d');
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    ctx.fillStyle = '#101114';
    ctx.fillRect(0, 0, S.box.w, S.box.h);
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.font = '16px ' + FONT_STACK;
    ctx.textAlign = 'center';
    ctx.fillText(p.t === 'image' ? '图片页 · 请在查看器中查看原图' : '音视频页 · 请在查看器中播放', S.box.w / 2, S.box.h / 2);
    return Promise.resolve();
  }

  /* ---------- 度量换算 ---------- */
  function ptFactor() {
    var sh = (S.manifest && S.manifest.slideH) || 6858000;
    return S.box.h / (sh / 12700);
  }
  function emuFactor() {
    var sw = (S.manifest && S.manifest.slideW) || 12192000;
    return S.box.w / sw;
  }

  /* ---------- 动画元素层 ---------- */
  function mainPageCanvas(n, p) {
    /* 主 PDF 页 → 离屏画布(2x 清晰度), 供 crop 元素裁剪 */
    return S.doc.getPage(n + 1).then(function (page) {
      var vp = page.getViewport({ scale: 1 });
      var scale = (2 * S.box.w) / vp.width;
      var vp2 = page.getViewport({ scale: scale });
      var c = el('canvas');
      c.width = Math.round(vp2.width);
      c.height = Math.round(vp2.height);
      return page.render({ canvasContext: c.getContext('2d'), viewport: vp2 }).promise.then(function () {
        return c;
      });
    });
  }

  function buildElements(mp, layer, p) {
    var ef = emuFactor();
    var recs = [];
    (mp.elements || []).forEach(function (e) {
      var d = el('div', 'pel');
      d.style.left = (e.x * 100) + '%';
      d.style.top = (e.y * 100) + '%';
      d.style.width = (e.w * 100) + '%';
      d.style.height = (e.h * 100) + '%';
      if (e.rot) d.style.transform = 'rotate(' + e.rot + 'deg)';
      var hasWipe = (e.steps || []).some(function (st) { return st.t === 'in' && st.e === 'wipe'; });
      if (hasWipe) d.style.overflow = 'hidden';
      var inner = el('div', 'pel-in');
      d.appendChild(inner);
      buildContent(e, inner, ef);
      var visibleInitially = !(e.steps || []).some(function (st) { return st.t === 'in'; });
      d.style.visibility = visibleInitially ? 'visible' : 'hidden';
      layer.appendChild(d);
      recs.push({ e: e, d: d, inner: inner });
    });
    S.pageEls = recs;
    var gs = {};
    recs.forEach(function (r) {
      (r.e.steps || []).forEach(function (st) {
        if (st.g >= 0) gs[st.g] = 1;
      });
    });
    S.playQueue = Object.keys(gs).map(Number).sort(function (a, b) { return a - b; });
    S.pi = 0;
    var cropRecs = recs.filter(function (r) { return r.e.kind === 'crop'; });
    if (!cropRecs.length) return Promise.resolve();
    return mainPageCanvas(p.n || 0, p).then(function (cv) {
      if (!cv) return;
      cropRecs.forEach(function (r) {
        try {
          var c2 = el('canvas');
          c2.width = Math.max(2, Math.round(r.e.w * cv.width));
          c2.height = Math.max(2, Math.round(r.e.h * cv.height));
          var cx = c2.getContext('2d');
          cx.drawImage(cv,
            Math.round(r.e.x * cv.width), Math.round(r.e.y * cv.height),
            c2.width, c2.height,
            0, 0, c2.width, c2.height);
          var img = el('img');
          img.src = c2.toDataURL('image/png');
          img.style.width = '100%'; img.style.height = '100%';
          img.draggable = false;
          r.inner.appendChild(img);
        } catch (err) { }
      });
    }).catch(function () { });
  }

  function buildContent(e, inner, ef) {
    if (e.kind === 'pic') {
      var url = S.imgMap[e.img];
      if (url) {
        var im = el('img');
        im.src = url; im.style.width = '100%'; im.style.height = '100%';
        im.style.objectFit = 'fill'; im.draggable = false;
        inner.appendChild(im);
      } else {
        inner.style.border = '1px dashed rgba(120,120,130,.5)';
      }
      return;
    }
    if (e.kind === 'crop') {
      inner.style.background = 'rgba(148,163,184,.08)';
      return; // 图片由 buildElements 异步裁剪填充
    }
    if (e.kind === 'table') {
      buildTable(e, inner, ef);
      return;
    }
    if (e.kind === 'rect' || e.kind === 'ellipse') {
      var sh = el('div', 'pel-shape');
      if (e.fill) sh.style.background = e.fill;
      if (e.line && e.lw) sh.style.border = e.lw + 'pt solid ' + e.line;
      if (e.kind === 'ellipse') sh.style.borderRadius = '50%';
      inner.appendChild(sh);
      if (e.paras) appendText(e, inner, ef);
      return;
    }
    if (e.kind === 'shape') {
      if (e.rr) {
        var rb = el('div', 'pel-shape');
        if (e.fill) rb.style.background = e.fill;
        if (e.line && e.lw) rb.style.border = e.lw + 'pt solid ' + e.line;
        var bw = e.w * S.box.w, bh = e.h * S.box.h;
        rb.style.borderRadius = Math.min(bw, bh) * 0.1667 + 'px';
        inner.appendChild(rb);
      } else if (e.pts) {
        var svgNS = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('viewBox', '0 0 100 100');
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.setAttribute('class', 'pel-svg');
        var poly = document.createElementNS(svgNS, 'polygon');
        poly.setAttribute('points', e.pts.map(function (p) { return p[0] + ',' + p[1]; }).join(' '));
        poly.setAttribute('fill', e.fill || 'none');
        if (e.line && e.lw) {
          poly.setAttribute('stroke', e.line);
          poly.setAttribute('stroke-width', Math.max(1, e.lw));
          poly.setAttribute('vector-effect', 'non-scaling-stroke');
        } else {
          poly.setAttribute('stroke', 'none');
        }
        svg.appendChild(poly);
        inner.appendChild(svg);
      }
      if (e.paras) appendText(e, inner, ef);
      return;
    }
    // text
    appendText(e, inner, ef);
  }

  function appendText(e, inner, ef) {
    var t = el('div', 'pel-text');
    t.style.justifyContent = ({ t: 'flex-start', ctr: 'center', b: 'flex-end' })[e.anchor || 't'];
    if (e.nowrap) t.style.whiteSpace = 'nowrap';
    if (e.ins) {
      t.style.paddingTop = (e.ins[1] * ef) + 'px';
      t.style.paddingRight = (e.ins[2] * ef) + 'px';
      t.style.paddingBottom = (e.ins[3] * ef) + 'px';
      t.style.paddingLeft = (e.ins[0] * ef) + 'px';
    }
    parasInto(t, e.paras, (e.fitScale || 1), ef, e.tc);
    inner.appendChild(t);
  }

  function parasInto(holder, paras, fitScale, ef, tc) {
    var kf = ptFactor();
    var numCtr = 0;
    (paras || []).forEach(function (pa) {
      var pd = el('div', 'pel-para');
      pd.style.textAlign = pa.align === 'ctr' ? 'center' : pa.align === 'r' ? 'right' : 'left';
      if (pa.lnSpc) pd.style.lineHeight = String(pa.lnSpc);
      else if (pa.lnSpcPt) pd.style.lineHeight = pa.lnSpcPt + 'pt';
      if (pa.sb) pd.style.marginTop = (pa.sb * kf) + 'px';
      if (pa.sa) pd.style.marginBottom = (pa.sa * kf) + 'px';
      var marL = (pa.marL || 0) * (ef || 0);
      if (marL > 0) pd.style.paddingLeft = marL + 'px';
      if (pa.bu) {
        if (pa.bu === 'num') numCtr++;
        var bsp = el('span');
        bsp.textContent = (pa.bu === 'num' ? (numCtr + '.') : pa.bu) + '\u00A0';
        if (pa.ind) bsp.style.marginLeft = (pa.ind * (ef || 0)) + 'px';
        bsp.style.color = (pa.runs && pa.runs[0] && pa.runs[0].c) || tc || '#111111';
        pd.appendChild(bsp);
      }
      (pa.runs || []).forEach(function (r) {
        var sp = el('span');
        sp.textContent = r.t === '' ? '\u00A0' : r.t;
        var f = r.fe || r.f || '';
        sp.style.fontFamily = f ? '"' + f + '",' + FONT_STACK : FONT_STACK;
        sp.style.fontSize = Math.max(4, Math.round(r.sz * kf * fitScale * 100) / 100) + 'px';
        if (r.b) sp.style.fontWeight = '700';
        if (r.i) sp.style.fontStyle = 'italic';
        sp.style.color = r.c || tc || '#111111';
        pd.appendChild(sp);
      });
      holder.appendChild(pd);
    });
  }

  function buildTable(e, inner, ef) {
    var kf = ptFactor();
    var tb = el('table', 'peltbl');
    var sum = (e.cols || []).reduce(function (a, b) { return a + b; }, 0) || 1;
    var cg = el('colgroup');
    (e.cols || []).forEach(function (c) {
      var col = el('col');
      col.style.width = (c / sum * 100) + '%';
      cg.appendChild(col);
    });
    tb.appendChild(cg);
    (e.rows || []).forEach(function (r) {
      var tr = el('tr');
      if (r.h) tr.style.height = Math.max(1, r.h * ef) + 'px';
      (r.cells || []).forEach(function (c) {
        var td = el('td');
        if (c.cs > 1) td.colSpan = c.cs;
        if (c.rs > 1) td.rowSpan = c.rs;
        if (c.fill) td.style.background = c.fill;
        var bd = c.bd || (e.tborder ? { l: 1, r: 1, t: 1, b: 1 } : null);
        if (bd) {
          function bs(side, defw) {
            var b = (c.bd && c.bd[side]) || (e.tborder ? { w: defw, c: '#555555' } : null);
            if (!b) return '';
            if (!b.w || b.c === null) return 'none';
            return b.w + 'pt solid ' + (b.c || '#555555');
          }
          td.style.borderTop = bs('t', 0.75);
          td.style.borderRight = bs('r', 0.75);
          td.style.borderBottom = bs('b', 0.75);
          td.style.borderLeft = bs('l', 0.75);
        }
        if (c.ins) {
          td.style.paddingTop = (c.ins[1] * ef) + 'px';
          td.style.paddingRight = (c.ins[2] * ef) + 'px';
          td.style.paddingBottom = (c.ins[3] * ef) + 'px';
          td.style.paddingLeft = (c.ins[0] * ef) + 'px';
        }
        td.style.verticalAlign = ({ t: 'top', ctr: 'middle', b: 'bottom' })[c.anchor || 'ctr'];
        if (c.img && S.imgMap[c.img]) {
          var im = el('img');
          im.src = S.imgMap[c.img];
          im.style.height = Math.max(6, Math.round((c.ih || 300000) * ef)) + 'px';
          im.style.maxWidth = '100%';
          im.draggable = false;
          td.appendChild(im);
        } else if (c.paras) {
          parasInto(td, c.paras, 1, ef, null);
        }
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    inner.appendChild(tb);
  }

  /* ---------- 动画执行 ---------- */
  function applyStep(rec, st, instant) {
    if (st.t === 'out') { runExit(rec, st); return; }
    if (st.t === 'pulse') { if (!instant) runPulse(rec, st); return; }
    runEnter(rec, instant, st);
  }

  function runEnter(rec, instant, st) {
    st = st || { e: 'appear', dur: 0 };
    var d = rec.d, inner = rec.inner;
    var dur = instant ? 0 : (st.dur || 500);
    d.style.visibility = 'visible';
    d.offsetHeight;
    if (st.e === 'appear' || dur <= 0) {
      d.style.transition = 'none'; d.style.opacity = '';
      inner.style.transition = 'none'; inner.style.transform = '';
      return;
    }
    if (st.e === 'wipe') {
      var dir = st.dir || 'right';
      inner.style.transition = 'none';
      inner.style.transform = dir === 'left' ? 'translateX(100%)' :
        dir === 'up' ? 'translateY(100%)' : dir === 'down' ? 'translateY(-100%)' : 'translateX(-100%)';
      inner.offsetHeight;
      inner.style.transition = 'transform ' + dur + 'ms ease';
      inner.style.transform = 'translate(0,0)';
      setTimeout(function () { d.style.overflow = ''; }, dur + 80);
      return;
    }
    var fromT = '', fromO = '';
    if (st.e === 'fade') { fromO = '0'; }
    else if (st.e === 'fly') {
      var m = String(st.dir || '0,1').split(',');
      var dx = parseFloat(m[0]) || 0, dy = parseFloat(m[1]) || 0;
      fromT = 'translate(' + Math.round(dx * S.box.w) + 'px,' + Math.round(dy * S.box.h) + 'px)';
    } else if (st.e === 'zoom') {
      fromT = 'scale(' + (st.scale || 0.25) + ')';
      fromO = '0';
    } else { fromO = '0'; }
    if (fromO) { d.style.transition = 'none'; d.style.opacity = fromO; }
    if (fromT) { inner.style.transition = 'none'; inner.style.transform = fromT; }
    d.offsetHeight;
    d.style.transition = 'opacity ' + dur + 'ms ease';
    d.style.opacity = '';
    inner.style.transition = 'transform ' + dur + 'ms ease';
    inner.style.transform = '';
  }

  function runExit(rec, st) {
    var d = rec.d;
    d.style.visibility = 'visible';
    d.style.transition = 'opacity ' + (st.dur || 400) + 'ms ease';
    d.style.opacity = '0';
  }

  function runPulse(rec, st) {
    var inner = rec.inner;
    inner.style.transition = 'transform 150ms ease';
    inner.style.transform = 'scale(1.08)';
    setTimeout(function () {
      inner.style.transition = 'transform 220ms ease';
      inner.style.transform = '';
    }, 170);
  }

  function playAuto() {
    flushAuto();
    S.pageEls.forEach(function (rec) {
      (rec.e.steps || []).forEach(function (st) {
        if (st.g !== -1) return;
        S.autoTimers.push(setTimeout(function () { applyStep(rec, st, false); }, st.delay || 0));
      });
    });
  }
  function flushAuto() {
    S.autoTimers.forEach(clearTimeout);
    S.autoTimers = [];
  }

  function advance() {
    if (S.pi < S.playQueue.length) {
      var g = S.playQueue[S.pi++];
      S.pageEls.forEach(function (rec) {
        (rec.e.steps || []).forEach(function (st) {
          if (st.g !== g) return;
          var dl = st.delay || 0;
          if (dl) {
            setTimeout(function () { applyStep(rec, st, false); }, dl);
          } else {
            applyStep(rec, st, false);
          }
        });
      });
      wakeUI();
    } else {
      nextPage();
    }
  }
  function revealAll() {
    while (S.pi < S.playQueue.length) {
      var g = S.playQueue[S.pi++];
      S.pageEls.forEach(function (rec) {
        (rec.e.steps || []).forEach(function (st) {
          if (st.g !== g) return;
          if (st.t === 'out') { rec.d.style.transition = 'none'; rec.d.style.opacity = '0'; }
          else if (st.t === 'in') runEnter(rec, true, st);
        });
      });
    }
  }
  function nextPage() { if (S.cur < S.pages.length - 1) showPage(S.cur + 1); else wakeUI(); }
  function prevPage() { if (S.cur > 0) showPage(S.cur - 1); else showPage(0); }

  /* ---------- 页间切换 ---------- */
  function transSwap(oldBox, newBox, tr) {
    var t = (tr && tr.transition && tr.transition.type) || 'fade';
    var dur = t === 'none' ? 0 : ((tr && tr.transition && tr.transition.dur) || 400);
    if (oldBox && oldBox.parentNode) {
      if (dur <= 0) { oldBox.parentNode.removeChild(oldBox); }
      else if (t === 'push' || t === 'cover' || t === 'wipe') {
        var dmap = { l: [1, 0], r: [-1, 0], u: [0, 1], d: [0, -1] };
        var m = dmap[(tr && tr.transition && tr.transition.dir) || 'l'] || dmap.l;
        var st = stageSize();
        var fx = m[0] * st.w, fy = m[1] * st.h;
        oldBox.style.zIndex = 1; newBox.style.zIndex = 2;
        newBox.style.transform = 'translate(' + fx + 'px,' + fy + 'px)';
        newBox.offsetHeight;
        newBox.style.transition = 'transform ' + dur + 'ms ease';
        newBox.style.transform = '';
        if (t === 'push') {
          oldBox.style.transition = 'transform ' + dur + 'ms ease';
          oldBox.style.transform = 'translate(' + (-fx) + 'px,' + (-fy) + 'px)';
        }
        setTimeout(function () { if (oldBox.parentNode) oldBox.parentNode.removeChild(oldBox); }, dur + 60);
      } else {
        oldBox.style.zIndex = 1; newBox.style.zIndex = 2;
        newBox.style.opacity = '0';
        newBox.offsetHeight;
        newBox.style.transition = 'opacity ' + dur + 'ms ease';
        newBox.style.opacity = '';
        oldBox.style.transition = 'opacity ' + dur + 'ms ease';
        oldBox.style.opacity = '0';
        setTimeout(function () { if (oldBox.parentNode) oldBox.parentNode.removeChild(oldBox); }, dur + 60);
      }
    }
  }

  /* ---------- 板书(与 viewer 数据互通) ---------- */
  function layoutInk(p) {
    S.ink.style.width = S.box.w + 'px';
    S.ink.style.height = S.box.h + 'px';
    S.ink.width = Math.round(S.box.w * S.dpr);
    S.ink.height = Math.round(S.box.h * S.dpr);
  }

  function strokePath(ctx, pts) {
    ctx.beginPath();
    if (pts.length === 1) { ctx.arc(pts[0][0], pts[0][1], .6, 0, Math.PI * 2); return; }
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length - 1; i++) {
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
    }
    var L = pts[pts.length - 1];
    ctx.lineTo(L[0], L[1]);
  }

  function drawStroke(ctx, s) {
    if (!s || !s.pts || !s.pts.length) return;
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (s.tool === 'text') {
      ctx.fillStyle = s.color;
      ctx.textBaseline = 'top';
      ctx.font = s.width + 'px ' + FONT_STACK;
      var lines = String(s.text || '').split('\n');
      for (var i = 0; i < lines.length; i++) ctx.fillText(lines[i], s.pts[0][0], s.pts[0][1] + i * s.width * 1.3);
      ctx.restore(); return;
    }
    if (s.tool === 'marker') ctx.globalAlpha = .42;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    strokePath(ctx, s.pts);
    ctx.stroke();
    if (s.pts.length === 1) {
      ctx.fillStyle = s.color;
      ctx.beginPath(); ctx.arc(s.pts[0][0], s.pts[0][1], (s.width || 2) / 2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function inkRedraw() {
    if (!S.ictx) return;
    var p = curPage();
    var k = S.box.w / (p.w || 1280);
    S.ictx.setTransform(S.dpr * k, 0, 0, S.dpr * k, 0, 0);
    S.ictx.clearRect(0, 0, p.w || 1280, p.h || 720);
    var arr = S.strokes[p.pid] || [];
    for (var i = 0; i < arr.length; i++) drawStroke(S.ictx, arr[i]);
  }

  function evPage(e) {
    var p = curPage();
    var r = S.boxEl.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (p.w || 1280) / (r.width || 1),
      y: (e.clientY - r.top) * (p.h || 720) / (r.height || 1)
    };
  }
  function strokesOf() {
    var pid = curPage().pid;
    return S.strokes[pid] || (S.strokes[pid] = []);
  }

  var downPt = null;
  function onDown(e) {
    wakeUI();
    downPt = { x: e.clientX, y: e.clientY, t: Date.now() };
    if (S.tool === 'pen' || S.tool === 'marker') {
      var cfg = S.tool === 'pen' ? S.pen : S.marker;
      var pt = evPage(e);
      S.drawing = { tool: S.tool, pts: [[pt.x, pt.y]], color: cfg.color, width: cfg.width };
      strokesOf().push(S.drawing);
    } else if (S.tool === 'eraser') {
      S.erasing = true;
      eraseAt(evPage(e));
    }
  }
  function onMove(e) {
    if (S.tool === 'laser') moveLaser(e);
    if (S.drawing) {
      var pt = evPage(e);
      var pts = S.drawing.pts;
      var L = pts[pts.length - 1];
      if (Math.abs(pt.x - L[0]) + Math.abs(pt.y - L[1]) > 1.2) pts.push([pt.x, pt.y]);
      inkRedraw();
    } else if (S.erasing) {
      eraseAt(evPage(e));
    }
  }
  function onUp(e) {
    if (S.drawing) {
      if (S.drawing.pts.length === 1) {
        var pt = evPage(e);
        S.drawing.pts.push([pt.x + .5, pt.y + .5]);
      }
      S.drawing = null;
      inkRedraw(); saveSoon();
    }
    S.erasing = false;
    if (downPt && S.tool === 'cursor') {
      var dx = e.clientX - downPt.x, dy = e.clientY - downPt.y;
      if (Math.abs(dx) < 9 && Math.abs(dy) < 9) advance();
      else if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        if (dx < 0) advance(); else prevPage();
      }
    }
    downPt = null;
  }
  function onStageClick(e) {
    if (e.target && e.target.closest && e.target.closest('#ptop,#ptools,#pblack')) return;
  }

  function segDist(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var l2 = dx * dx + dy * dy;
    if (!l2) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    var t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }
  function eraseAt(pt) {
    var pid = curPage().pid;
    var arr = S.strokes[pid] || [];
    var r = (S.eraser.width || 28) / 2;
    for (var i = arr.length - 1; i >= 0; i--) {
      var s = arr[i], hit = false;
      if (s.tool === 'text') {
        hit = pt[0] >= s.pts[0][0] - 20 && pt[0] <= s.pts[0][0] + (String(s.text || '').length * s.width * .6 + 20) &&
              pt[1] >= s.pts[0][1] - 10 && pt[1] <= s.pts[0][1] + s.width * 1.4;
      } else {
        for (var j = 0; j < s.pts.length; j++) {
          var a = s.pts[j], b = s.pts[Math.min(j + 1, s.pts.length - 1)];
          if (segDist(pt, a, b) < r) { hit = true; break; }
        }
      }
      if (hit) { arr.splice(i, 1); saveSoon(); }
    }
    inkRedraw();
  }

  /* ---------- 激光笔 ---------- */
  function moveLaser(e) {
    var dot = document.getElementById('plaser');
    if (!dot) return;
    dot.style.display = 'block';
    dot.style.left = (e.clientX - 7) + 'px';
    dot.style.top = (e.clientY - 7) + 'px';
    dot.classList.add('hot');
    clearTimeout(S.lid);
    S.lid = setTimeout(function () { dot.classList.remove('hot'); }, 900);
  }

  /* ---------- 保存 ---------- */
  function serialize() {
    var out = {
      pages: S.pages.map(function (p) { return { t: p.t, n: p.n, pid: p.pid, bg: p.bg || 'w' }; }),
      strokes: S.strokes
    };
    if (S.bbN && S.bbN > 1) out.bb = { n: S.bbN };
    return out;
  }
  function saveSoon() {
    S.dirty = true;
    clearTimeout(S.saveT);
    S.saveT = setTimeout(saveNow, 900);
  }
  function saveNow() {
    if (!S.dirty) return Promise.resolve();
    return fetch('/api/files/' + FID + '/annotations', {
      method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, AUTH),
      body: JSON.stringify(serialize())
    }).then(function () { S.dirty = false; }).catch(function () { });
  }
  function flushSave() {
    if (!S.dirty) return;
    try {
      fetch('/api/files/' + FID + '/annotations', {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
        body: JSON.stringify(serialize()), keepalive: true
      });
      S.dirty = false;
    } catch (e) { }
  }

  /* ---------- 键盘 ---------- */
  function onKey(e) {
    if (e.target && /INPUT|TEXTAREA|SELECT|VIDEO|AUDIO/.test(e.target.tagName)) return;
    var k = e.key;
    if (k === 'ArrowRight' || k === ' ' || k === 'PageDown' || k === 'Enter') { e.preventDefault(); advance(); }
    else if (k === '.' || k === 'ArrowDown') { e.preventDefault(); revealAll(); }
    else if (k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); prevPage(); }
    else if (k === 'Home') showPage(0);
    else if (k === 'End') showPage(S.pages.length - 1);
    else if (k === 'Escape') exitPresent();
    else if (k === 'b' || k === 'B') blackout('#000');
    else if (k === 'w' || k === 'W') blackout('#fff');
    else if (k === 'p' || k === 'P') toggleTools();
    else if (k === 'l' || k === 'L') setTool(S.tool === 'laser' ? 'cursor' : 'laser');
    else if (k === 's' || k === 'S') toggleCompare();
    else if (k === 'f' || k === 'F') toggleFull();
    else if (k === 't' || k === 'T') { S.t0 = Date.now(); }
    else if (k === 'd' || k === 'D') { debugInfo(); }
  }
  function setModeDot() {
    var d = document.getElementById('pmode');
    if (!d) return;
    var p = curPage();
    var mp = p.t === 'pdf' ? mPage(p.n) : null;
    var mode = mp ? mp.mode : (S.manifest ? 'static' : 'none');
    var cnt = mp ? (mp.elements || []).length : 0;
    if (mode === 'elements') {
      d.style.color = '#4ade80';
      d.title = '\u52a8\u753b\u5143\u7d20\u6a21\u5f0f \u00b7 ' + cnt + ' \u4e2a\u5143\u7d20';
    } else {
      d.style.color = '#f87171';
      d.title = '\u9759\u6001PDF\u6a21\u5f0f(' +
        (S.manifest ? '\u672c\u9875\u65e0\u5f62\u72b6' : '\u65e0\u52a8\u753b\u6570\u636e, \u8bf7\u5728\u8bfe\u4ef6\u5361\u7247\u70b9\u91cd\u8bd5') + ')';
    }
  }

  function debugInfo() {
    var p = curPage();
    var mp = p.t === 'pdf' ? mPage(p.n) : null;
    var lines = [
      '\u9875 ' + (S.cur + 1) + ' / ' + S.pages.length,
      '\u6e05\u5355\u7248\u672c: v' + (S.manifest ? S.manifest.v : '-'),
      '\u672c\u9875\u6a21\u5f0f: ' + (mp ? mp.mode : (S.manifest ? 'static' : 'none')),
      '\u5143\u7d20\u6570: ' + (mp ? (mp.elements || []).length : 0),
      '\u80cc\u666f: ' + (S.bgFailed ? '\u5931\u8d25(\u5df2\u7528\u4e3bPDF)' : (S.bgDoc ? 'bg.pdf' : '\u4e3bPDF'))
    ];
    var h = document.getElementById('phint');
    if (h) {
      h.textContent = lines.join(' \u00b7 ');
      h.classList.remove('off');
      setTimeout(function () { h.classList.add('off'); }, 5000);
    }
  }

  function blackout(color) {
    var b = document.getElementById('pblack');
    if (!b) return;
    if (b.style.display === 'block' && b.style.background === color) { b.style.display = 'none'; return; }
    b.style.display = 'block';
    b.style.background = color;
    b.onclick = function () { b.style.display = 'none'; };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
