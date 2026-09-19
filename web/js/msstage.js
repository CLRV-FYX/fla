/* ================================================================
 * FLA v1.27 — 微软放映舞台 (MSStage)
 * ----------------------------------------------------------------
 * 解决的老大难: 微软 Office 在线视图是【跨域 iframe】, 父页面既读不到它当前
 * 在第几页, 也没法命令它翻页 → 板书画布永远停在第一页, 与画面脱节。
 *
 * 本模块的做法(画布严格随页切换):
 *  1. 由【我方】掌握页码: 翻页 = 换 iframe.src(同一个 src, 只改 wdStartOn /
 *     wdSlideId 定位参数)。页码是我方的状态, 画布层自然严格跟着走;
 *     src 不变 → 微软侧的转换缓存可复用, 不需要重新转换。
 *  2. 双 iframe 乒乓 + 预载下一页: 前进几乎是瞬时(下一页已在后台就绪),
 *     切换用 220ms 交叉淡入, 不闪黑屏。
 *  3. 画布坐标绑定【幻灯区域】而不是整个窗口: 按文档真实宽高比做 letterbox
 *     计算, 笔迹落在幻灯片上; 还能手动微调板书区域(拖动/缩放, 存到服务器)。
 *  4. 三种同步模式, 老师可随时切换(顶栏「同步」按钮):
 *       deep   我方驱动(默认) — ‹ › / 缩略图 / 数字键 直接翻页, 画布同步
 *       follow 微软自翻       — 老师点微软画面翻页, 板书用 ‹ › 或 Ctrl+← → 对齐
 *       (还有「本地引擎」按钮 → 完全离线的高保真渲染, 见 present.js)
 *  5. 首次进入会做一次「对齐自检」: 翻到第 2 页看微软画面是否跟着跳,
 *     不跳就自动建议切到 follow 模式, 并记住老师的选择。
 *
 * 纯 ES5(兼容学校旧浏览器 Chrome 60+), 与 viewer.js / present.js 的批注数据互通:
 *   { pages:[{t,n,pid,bg}], strokes:{pid:[...]}, bb:{n}, ms:{rect,sync,extra} }
 * 入口: MSStage.mount(opts) -> Promise<stage>
 * ================================================================ */
(function () {
  'use strict';

  var FONT = '-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif';
  var VW = 1280, VH = 720;                 /* 板书虚拟坐标系(与旧数据一致) */
  var PEN_COLORS = ['#ef4444', '#1f2937', '#2563eb', '#059669', '#f59e0b', '#ffffff'];
  var MARKER_COLORS = ['#fde047', '#86efac', '#93c5fd', '#f9a8d4', '#fdba74'];
  var SHAPE_COLORS = ['#ef4444', '#111827', '#2563eb', '#059669', '#9333ea', '#ffffff'];
  var TEXT_COLORS = ['#ef4444', '#1f2937', '#2563eb', '#059669', '#f59e0b', '#ffffff'];
  var SHAPE_LIST = [['line', '直线'], ['arrow', '箭头'], ['rect', '矩形'], ['ellipse', '椭圆'], ['triangle', '三角形']];
  var BOARD_BG = { w: '#ffffff', k: '#14171c', g: '#1c3b2d' };
  var TOOLS = [
    ['cursor', '正常模式 · 点击画面交给微软 (Esc)', 'cursor'],
    ['select', '选择 / 移动板书 (1)', 'select'],
    ['pen', '笔 (2)', 'pen'],
    ['marker', '荧光笔 (3)', 'marker'],
    ['shape', '几何图形 (4)', 'shapes'],
    ['text', '文本 (5)', 'text'],
    ['laser', '激光笔 (6)', 'laser'],
    ['eraser', '橡皮 (7)', 'eraser']
  ];
  var KEY_TOOL = { '1': 'select', '2': 'pen', '3': 'marker', '4': 'shape', '5': 'text', '6': 'laser', '7': 'eraser' };
  var SHAPE_MINI = {
    line: '<path d="M5 19L19 5"/>',
    arrow: '<path d="M5 19L19 5"/><path d="M13 5h6v6"/>',
    rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="9" ry="7"/>',
    triangle: '<path d="M12 4l9 16H3z"/>'
  };
  var ICONS = {
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
    full: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
    board: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M12 17v3M8 21h8"/>',
    plusPage: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 11v6M9 14h6"/>',
    bolt: '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/>',
    square: '<rect x="4.5" y="4.5" width="15" height="15" rx="2"/>',
    chevL: '<path d="m15 18-6-6 6-6"/>',
    chevR: '<path d="m9 18 6-6-6-6"/>',
    film: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M7 5v14M17 5v14M2.5 12h19"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    move: '<path d="M12 2v20M2 12h20"/><path d="m12 2-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3"/>',
    sync: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
    back: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
    down: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M9 2h6"/>'
  };

  function icon(n, s) {
    return '<svg width="' + (s || 20) + '" height="' + (s || 20) + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[n] || '') + '</svg>';
  }
  function el(tag, cls, css) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (css) d.style.cssText = css;
    return d;
  }
  function svgEl(w, h, inner, sw) {
    return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="' + (sw || 2) + '" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  }
  function st(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  function stSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }
  function uid() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function fmtT(sec) {
    var m = Math.floor(sec / 60), s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* ================================================================== */
  function mount(opts) {
    opts = opts || {};
    var S = {
      fid: opts.fid, token: opts.token || '', mode: opts.mode || 'present',
      meta: opts.meta || {}, mv: null, ann: null,
      slides: 1, extra: 0, page: 1, bbN: 1,
      strokes: {}, ops: {}, redos: {}, bbOps: {}, bbRedos: {},
      tool: 'cursor', drawing: null, selId: null, selOff: null, laserDots: [],
      dirty: false, saveT: 0, dead: false, t0: Date.now(),
      rect: null, frames: [], fcur: -1, loading: 0,
      sync: st('fla_ms_sync', 'deep'), thumbs: {}, pdf: null, pdfBusy: false,
      bbOpen: false, bbCur: 0, cfg: null, hideT: 0, align: null, dpr: 1,
      keepToolbar: st('fla_keep_toolbar', '1') !== '0',   /* 默认工具栏常驻不收起 */
      manifest: null, stepInSlide: 0
    };
    var CFG_DEFAULT = {
      pen: { color: '#ef4444', width: 4 },
      marker: { color: '#fde047', width: 18 },
      shape: { type: 'rect', color: '#ef4444', width: 3 },
      text: { color: '#ef4444', size: 30 },
      eraser: { width: 28, mode: 'object' },
      boardBg: 'w'
    };
    try {
      /* localStorage 里存坏了(手改/旧版本)也不能让放映台起不来 */
      S.cfg = JSON.parse(st('fla_ms_cfg', 'null')) || CFG_DEFAULT;
    } catch (e) { S.cfg = CFG_DEFAULT; try { localStorage.removeItem('fla_ms_cfg'); } catch (e2) { } }
    for (var ck in CFG_DEFAULT) if (!S.cfg[ck]) S.cfg[ck] = CFG_DEFAULT[ck];

    var AUTH = { Authorization: 'Bearer ' + S.token };
    function jget(u) {
      return fetch(u, { headers: AUTH }).then(function (r) {
        if (r.status === 401) throw new Error('登录已过期, 请回到课件页重新进入');
        if (!r.ok) throw new Error('请求失败 (' + r.status + ')');
        return r.json();
      });
    }

    /* ---------------- DOM 骨架 ---------------- */
    var host = opts.mount || document.body;
    var wrap = el('div', 'ms-stage');
    var ifrBox = el('div', 'ms-ifrbox');
    var board = el('div', 'ms-board');            /* 附加板书页 / 板中板底色 */
    var ink = el('canvas', 'ms-ink');
    var laser = el('canvas', 'ms-laser');
    var rectGuide = el('div', 'ms-rect hidden');  /* 板书区域可视化 + 手动调整 */
    ifrBox.appendChild(board);
    wrap.appendChild(ifrBox);
    wrap.appendChild(ink);
    wrap.appendChild(laser);
    wrap.appendChild(rectGuide);

    var ictx = ink.getContext('2d');
    var lctx = laser.getContext('2d');

    /* ---------------- 顶栏 ---------------- */
    var top = el('div', 'ms-top');
    top.innerHTML =
      '<button class="ms-tb" data-a="exit" title="退出 (Esc)">' + icon('back', 17) + '</button>' +
      '<span class="ms-title" id="msTitle"></span>' +
      '<span class="ms-sep"></span>' +
      '<button class="ms-tb" data-a="prev" title="上一页 (←)">' + icon('chevL', 18) + '</button>' +
      '<button class="ms-page" id="msPage" title="点击输入页码 / 打开缩略图">1 / 1</button>' +
      '<button class="ms-tb" data-a="next" title="下一页 (→)">' + icon('chevR', 18) + '</button>' +
      '<span class="ms-sep"></span>' +
      '<button class="ms-tb" data-a="film" title="缩略图导航 (G)">' + icon('film', 17) + '</button>' +
      '<button class="ms-tb" data-a="sync" id="msSync" title="板书与微软画面的同步方式">' + icon('sync', 17) + '<em id="msSyncT">我方驱动</em></button>' +
      '<button class="ms-tb' + (S.keepToolbar ? ' on' : '') + '" data-a="pin" id="msPin" title="工具栏常驻显示 / 自动收起">' + icon('lock', 16) + '<em id="msPinTxt">' + (S.keepToolbar ? '工具栏常驻' : '自动收起') + '</em></button>' +
      '<button class="ms-tb" data-a="align" title="微调板书区域(对准幻灯片)">' + icon('move', 17) + '</button>' +
      '<span class="ms-sep"></span>' +
      '<button class="ms-tb" data-a="time" id="msTime" title="点击归零">00:00</button>' +
      '<button class="ms-tb" data-a="full" title="全屏 (F)">' + icon('full', 17) + '</button>';
    wrap.appendChild(top);

    /* ---------------- 左侧工具条 ---------------- */
    var barL = el('nav', 'ms-pill ms-pill-l');
    TOOLS.forEach(function (t) {
      var b = el('button', 'ms-vbtn' + (t[0] === 'cursor' ? ' on' : ''));
      b.setAttribute('data-tool', t[0]); b.title = t[1]; b.innerHTML = icon(t[2], 20);
      barL.appendChild(b);
    });
    barL.appendChild(el('i', 'ms-vsep'));
    function vbtn(cls, act, title, ic) {
      var b = el('button', 'ms-vbtn ' + (cls || ''));
      b.setAttribute('data-a', act); b.title = title; b.innerHTML = ic;
      barL.appendChild(b); return b;
    }
    vbtn('', 'undo', '撤销 (Ctrl+Z)', icon('undo', 20));
    vbtn('', 'redo', '重做 (Ctrl+Y)', icon('redo', 20));
    barL.appendChild(el('i', 'ms-vsep'));
    vbtn('', 'pgprev', '板书上一页', icon('chevL', 19));
    vbtn('', 'addpage', '加一页板书(在末页之后)', icon('plusPage', 19));
    vbtn('', 'pgnext', '板书下一页', icon('chevR', 19));
    wrap.appendChild(barL);

    /* ---------------- 右侧工具条 ---------------- */
    var barR = el('nav', 'ms-pill ms-pill-r');
    function rbtn(act, title, ic) {
      var b = el('button', 'ms-vbtn');
      b.setAttribute('data-a', act); b.title = title; b.innerHTML = ic;
      barR.appendChild(b); return b;
    }
    rbtn('film', '缩略图导航 (G)', icon('film', 20));
    rbtn('clear', '清空本页板书', icon('trash', 20));
    rbtn('bnb', '板中板: 独立小黑板(可加页)', icon('board', 20));
    rbtn('bg', '板书页底色: 白 / 黑板 / 绿黑板', '<span class="ms-dotbg"></span>');
    rbtn('black', '黑屏 (B)', icon('square', 20));
    rbtn('local', '本地引擎(离线高保真渲染, 含动画)', icon('bolt', 20));
    if (S.mode === 'view') {
      rbtn('present', '全屏放映', icon('full', 20));
      rbtn('refresh', '重新载入微软画面(卡住/空白时用)', icon('sync', 20));
      rbtn('dl', '下载原文件', icon('down', 20));
    }
    wrap.appendChild(barR);

    /* ---------------- 工具配置弹窗 ---------------- */
    var pop = el('div', 'ms-pop hidden');
    wrap.appendChild(pop);

    /* ---------------- 提示 / 加载 / 黑屏 / 板中板 ---------------- */
    var toasts = el('div', 'ms-toasts'); wrap.appendChild(toasts);
    var load = el('div', 'ms-load');
    load.innerHTML = '<div class="ms-spin"></div><p id="msLoadT">微软服务器正在抓取课件…</p>' +
      '<p class="ms-load-sub" id="msLoadS">首次约 30–60 秒; 之后翻页走缓存, 很快</p>';
    wrap.appendChild(load);
    var blk = el('div', 'ms-black hidden'); wrap.appendChild(blk);
    var film = el('div', 'ms-film hidden'); wrap.appendChild(film);

    var bnb = el('div', 'ms-bnb');
    bnb.innerHTML = '<div class="ms-bnb-bar">' +
      '<b>板中板</b><button class="ms-tb" data-b="prev">' + icon('chevL', 15) + '</button>' +
      '<span id="bbPg">1 / 1</span><button class="ms-tb" data-b="next">' + icon('chevR', 15) + '</button>' +
      '<button class="ms-tb" data-b="add" title="加一页">' + icon('plusPage', 15) + '</button>' +
      '<button class="ms-tb" data-b="clear" title="清空本页">' + icon('trash', 15) + '</button>' +
      '<button class="ms-tb" data-b="close" title="收起">✕</button></div>' +
      '<canvas id="bbCv"></canvas>';
    wrap.appendChild(bnb);
    var bbCv = bnb.querySelector('#bbCv');

    host.appendChild(wrap);

    /* ==================================================================
     *  几何: 幻灯区域(板书坐标系绑定它)
     * ================================================================== */
    function viewport() {
      var r = wrap.getBoundingClientRect();
      return { w: r.width || window.innerWidth, h: r.height || window.innerHeight };
    }
    /* 手动微调的板书区域(归一化 0..1), 存服务器 */
    function slideRect() {
      var v = viewport();
      if (S.rect) {
        return { x: S.rect[0] * v.w, y: S.rect[1] * v.h, w: S.rect[2] * v.w, h: S.rect[3] * v.h };
      }
      var ar = (S.mv && S.mv.aspect) || 1.777778;
      var isPpt = !S.mv || S.mv.family === 'ppt';
      /* 微软自己的控件条在底部(约 44px), 我方顶栏在上(约 46px) */
      var topI = S.mode === 'present' ? 8 : 52, botI = isPpt ? 46 : 26;
      var aw = v.w, ah = Math.max(80, v.h - topI - botI);
      var k = Math.min(aw / ar, ah) / 1;
      var w = ar * k, h = k;
      if (w > aw) { w = aw; h = aw / ar; }
      return { x: (v.w - w) / 2, y: topI + (ah - h) / 2, w: w, h: h };
    }
    function toVirt(cx, cy) {
      var r = wrap.getBoundingClientRect(), g = slideRect();
      return [(cx - r.left - g.x) / (g.w || 1) * VW, (cy - r.top - g.y) / (g.h || 1) * VH];
    }
    function sizeCanvas() {
      var v = viewport(), dpr = Math.min(window.devicePixelRatio || 1, 2);
      S.dpr = dpr;
      if (ink.width !== Math.round(v.w * dpr) || ink.height !== Math.round(v.h * dpr)) {
        ink.width = Math.round(v.w * dpr); ink.height = Math.round(v.h * dpr);
        laser.width = ink.width; laser.height = ink.height;
      }
      ink.style.width = v.w + 'px'; ink.style.height = v.h + 'px';
      laser.style.width = v.w + 'px'; laser.style.height = v.h + 'px';
      redraw();
      if (S.bbOpen) bbRedraw();
    }

    /* ==================================================================
     *  笔迹绘制
     * ================================================================== */
    function strokePath(c, pts) {
      c.beginPath();
      if (pts.length === 1) { c.arc(pts[0][0], pts[0][1], .6, 0, Math.PI * 2); return; }
      c.moveTo(pts[0][0], pts[0][1]);
      for (var i = 1; i < pts.length - 1; i++) {
        c.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
      }
      c.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    }
    function snap45(a, b) {
      var dx = b[0] - a[0], dy = b[1] - a[1];
      var ang = Math.atan2(dy, dx), d = Math.sqrt(dx * dx + dy * dy);
      var s = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
      return [a[0] + Math.cos(s) * d, a[1] + Math.sin(s) * d];
    }
    function shapePath(c, s) {
      var a = s.pts[0], b = s.pts[1] || s.pts[0];
      if (s.shape === 'line' || s.shape === 'arrow') b = snap45(a, b);
      c.beginPath();
      if (s.shape === 'line' || s.shape === 'arrow') {
        c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]);
        if (s.shape === 'arrow') {
          var ang = Math.atan2(b[1] - a[1], b[0] - a[0]), hl = Math.max(10, s.width * 3.5);
          c.moveTo(b[0], b[1]); c.lineTo(b[0] - hl * Math.cos(ang - .45), b[1] - hl * Math.sin(ang - .45));
          c.moveTo(b[0], b[1]); c.lineTo(b[0] - hl * Math.cos(ang + .45), b[1] - hl * Math.sin(ang + .45));
        }
      } else if (s.shape === 'rect') {
        c.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      } else if (s.shape === 'ellipse') {
        c.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.abs(b[0] - a[0]) / 2, Math.abs(b[1] - a[1]) / 2, 0, 0, Math.PI * 2);
      } else {
        c.moveTo((a[0] + b[0]) / 2, Math.min(a[1], b[1]));
        c.lineTo(Math.max(a[0], b[0]), Math.max(a[1], b[1]));
        c.lineTo(Math.min(a[0], b[0]), Math.max(a[1], b[1]));
        c.closePath();
      }
    }
    function drawStroke(c, s) {
      if (!s || !s.pts || !s.pts.length) return;
      c.save();
      c.lineCap = 'round'; c.lineJoin = 'round';
      if (s.tool === 'text') {
        c.fillStyle = s.color; c.textBaseline = 'top';
        c.font = s.width + 'px ' + FONT;
        var ls = String(s.text || '').split('\n');
        for (var i = 0; i < ls.length; i++) c.fillText(ls[i], s.pts[0][0], s.pts[0][1] + i * s.width * 1.3);
        c.restore(); return;
      }
      if (s.tool === 'shape') {
        c.strokeStyle = s.color; c.lineWidth = s.width; shapePath(c, s); c.stroke(); c.restore(); return;
      }
      if (s.tool === 'marker') c.globalAlpha = .42;
      c.strokeStyle = s.color; c.lineWidth = s.width;
      strokePath(c, s.pts); c.stroke();
      if (s.pts.length === 1) {
        c.fillStyle = s.color; c.beginPath();
        c.arc(s.pts[0][0], s.pts[0][1], (s.width || 2) / 2, 0, Math.PI * 2); c.fill();
      }
      c.restore();
    }
    function bounds(s) {
      var xs = [], ys = [];
      if (s.tool === 'text') {
        var w = String(s.text || '').length * s.width * .62, h = s.width * 1.35;
        xs = [s.pts[0][0], s.pts[0][0] + w]; ys = [s.pts[0][1], s.pts[0][1] + h];
      } else if (s.tool === 'shape') {
        var a = s.pts[0], b = s.pts[1] || s.pts[0];
        if (s.shape === 'line' || s.shape === 'arrow') b = snap45(a, b);
        xs = [a[0], b[0]]; ys = [a[1], b[1]];
      } else {
        (s.pts || []).forEach(function (p) { xs.push(p[0]); ys.push(p[1]); });
      }
      if (!xs.length) return { x0: 0, y0: 0, x1: 0, y1: 0 };
      return { x0: Math.min.apply(null, xs), y0: Math.min.apply(null, ys),
               x1: Math.max.apply(null, xs), y1: Math.max.apply(null, ys) };
    }
    function pid() {
      return S.page <= S.slides ? 'm' + (S.page - 1) : 'x' + (S.page - S.slides - 1);
    }
    function isBoardPage() { return S.page > S.slides; }
    function redraw(preview) {
      var v = viewport(), g = slideRect();
      ictx.setTransform(1, 0, 0, 1, 0, 0);
      ictx.clearRect(0, 0, ink.width, ink.height);
      ictx.save();
      ictx.scale(S.dpr, S.dpr);
      ictx.translate(g.x, g.y);
      ictx.scale(g.w / VW, g.h / VH);
      var arr = S.strokes[pid()] || [];
      for (var i = 0; i < arr.length; i++) {
        drawStroke(ictx, arr[i]);
        if (S.selId && arr[i].id === S.selId) {
          var b = bounds(arr[i]), pad = 10;
          ictx.save();
          ictx.strokeStyle = '#3b82f6'; ictx.lineWidth = 2 * VW / (g.w || VW);
          ictx.setLineDash([8, 6]);
          ictx.strokeRect(b.x0 - pad, b.y0 - pad, b.x1 - b.x0 + pad * 2, b.y1 - b.y0 + pad * 2);
          ictx.restore();
        }
      }
      if (preview) drawStroke(ictx, preview);
      ictx.restore();
      /* 板书区域参考框(仅调整模式) */
      board.style.display = isBoardPage() ? '' : 'none';
      if (isBoardPage()) {
        board.style.background = BOARD_BG[S.cfg.boardBg] || BOARD_BG.w;
        board.style.left = g.x + 'px'; board.style.top = g.y + 'px';
        board.style.width = g.w + 'px'; board.style.height = g.h + 'px';
      }
      void v;
    }

    /* ==================================================================
     *  微软 iframe: 双缓冲 + 预载下一页
     * ================================================================== */
    function getSlideStepCount(slideIndex1Based) {
      if (!S.manifest || !S.manifest.pages) return 0;
      var p = S.manifest.pages[slideIndex1Based - 1];
      if (!p || !p.elements) return 0;
      var gs = {};
      p.elements.forEach(function (e) {
        (e.steps || []).forEach(function (st) {
          if (st.g >= 0) gs[st.g] = 1;
        });
      });
      return Object.keys(gs).length;
    }
    function focusIframe() {
      var f = curFrame();
      if (f && f.contentWindow) {
        try {
          f.contentWindow.focus();
          f.contentWindow.postMessage(JSON.stringify({ MessageId: 'Grab_Focus', SendTime: Date.now(), Values: {} }), '*');
        } catch (e) { }
      }
    }
    function postNavToIframe(f, dir) {
      f = f || curFrame();
      if (!f || !f.contentWindow) return;
      try {
        var isNext = dir === 'next';
        var msgs = [
          { MessageId: isNext ? 'Action_NextSlide' : 'Action_PreviousSlide', SendTime: Date.now(), Values: {} },
          { MessageId: isNext ? 'UI_Next' : 'UI_Prev', SendTime: Date.now(), Values: {} },
          { MessageId: 'Action_NavigateTo', SendTime: Date.now(), Values: { direction: isNext ? 'next' : 'previous' } },
          { MessageId: 'Grab_Focus', SendTime: Date.now(), Values: {} }
        ];
        msgs.forEach(function (m) {
          f.contentWindow.postMessage(JSON.stringify(m), '*');
        });
      } catch (err) {}
    }
    function triggerNext() {
      var isOcr = window.FLA_OCR && window.FLA_OCR.isCapturing();
      var f = curFrame();
      postNavToIframe(f, 'next');
      focusIframe();

      if (S.sync === 'follow' && !isOcr) {
        var stepCount = getSlideStepCount(S.page);
        if (stepCount > 0 && S.stepInSlide < stepCount) {
          S.stepInSlide++;
          updatePill();
          return;
        }
      }
      S.stepInSlide = 0;
      nextPage();
      updatePill();
    }
    function triggerPrev() {
      var isOcr = window.FLA_OCR && window.FLA_OCR.isCapturing();
      var f = curFrame();
      postNavToIframe(f, 'prev');
      focusIframe();

      if (S.sync === 'follow' && !isOcr) {
        if (S.stepInSlide > 0) {
          S.stepInSlide--;
          updatePill();
          return;
        }
      }
      S.stepInSlide = 0;
      prevPage();
      updatePill();
    }
    function urlFor(n) {
      if (!S.mv) return '';
      if (!S.mv.deep_link || n <= 1) return S.mv.url;
      var tpl = S.mv.url_tpl || S.mv.url;
      var id = (S.mv.slide_ids && S.mv.slide_ids[n - 1]) || 0;
      return tpl.replace('{n}', n).replace('{id}', id || '');
    }
    function mkFrame() {
      var f = el('iframe', 'ms-frame');
      f.setAttribute('allowfullscreen', 'true');
      f.setAttribute('frameborder', '0');
      f.setAttribute('scrolling', 'no');
      f.style.opacity = '0';
      f.page = 0; f.state = 'idle'; f.token = 0;
      ifrBox.appendChild(f);
      return f;
    }
    function showLoad(on, txt) {
      if (on) {
        if (txt) load.querySelector('#msLoadT').textContent = txt;
        load.classList.remove('hidden');
      } else load.classList.add('hidden');
    }
    function hideFrames() {
      for (var i = 0; i < S.frames.length; i++) S.frames[i].style.opacity = '0';
      showLoad(false);
    }
    /* 把某个 iframe 载入第 n 页; 完成后回调(交叉淡入, 不闪黑屏) */
    function loadInto(f, n, cb) {
      var tk = ++f.token;
      f.state = 'loading'; f.page = n;
      var to = setTimeout(function () {
        if (f.token !== tk) return;
        /* 微软抓取慢: 提示但不放弃, 继续等 onload */
        load.querySelector('#msLoadS').textContent = '微软首次抓取这份文档较慢(30–60 秒), 之后翻页走缓存';
      }, 20000);
      f.onload = function () {
        if (f.token !== tk) return;
        clearTimeout(to);
        f.state = 'ready';
        /* 微软 onload 后还要一会儿才把幻灯片画出来 */
        setTimeout(function () { if (f.token === tk && f.state === 'ready' && cb) cb(f); }, 420);
      };
      f.onerror = function () { if (f.token === tk) { clearTimeout(to); f.state = 'error'; } };
      f.src = urlFor(n);
    }
    function swapTo(f) {
      if (S.dead || !f) return;
      for (var i = 0; i < S.frames.length; i++) {
        var x = S.frames[i];
        if (x === f) { x.style.opacity = '1'; x.style.zIndex = '2'; }
        else { x.style.opacity = '0'; x.style.zIndex = '1'; }
      }
      S.fcur = S.frames.indexOf(f);
      showLoad(false);
      load.querySelector('#msLoadS').textContent = '首次约 30–60 秒; 之后翻页走缓存, 很快';
      preloadNext();
    }
    function frameWith(n) {
      for (var i = 0; i < S.frames.length; i++) {
        if (S.frames[i].page === n && S.frames[i].state !== 'idle') return S.frames[i];
      }
      return null;
    }
    function curFrame() { return S.frames[S.fcur] || null; }
    /* 选一个"可以牺牲"的 iframe: 不是当前显示的, 也不是已预载的下一页 */
    function spareFrame() {
      var i, f;
      for (i = 0; i < S.frames.length; i++) {
        f = S.frames[i];
        if (f !== curFrame() && f.page !== S.page + 1 && f.page !== S.page) return f;
      }
      for (i = 0; i < S.frames.length; i++) {
        f = S.frames[i];
        if (f !== curFrame()) return f;
      }
      return curFrame() || S.frames[0];
    }
    /* 预载下一页 → 前进翻页几乎瞬时(课堂最常用的方向) */
    function preloadNext() {
      if (S.sync !== 'deep' || S.frames.length < 2) return;
      var n = S.page + 1;
      if (n > S.slides || frameWith(n)) return;
      var f = spareFrame();
      if (!f || f === curFrame()) return;
      f.style.opacity = '0'; f.style.zIndex = '1';
      loadInto(f, n, null);
    }
    function showSlide(n) {
      if (n > S.slides) { hideFrames(); return; }  /* 附加板书页: 收起微软画面 */
      var cf = curFrame();
      if (cf && cf.style.opacity === '0') { cf.style.opacity = '1'; cf.style.zIndex = '2'; }
      if (S.sync !== 'deep') return;               /* follow / OCR 模式由 postNavToIframe / 识屏驱动 */
      var f = frameWith(n);
      if (f) {
        if (f.state === 'ready') swapTo(f);
        else {
          showLoad(true, '正在切到第 ' + n + ' 页…');
          var tk = f.token;
          var wait = setInterval(function () {
            if (S.dead) { clearInterval(wait); return; }
            if (f.token !== tk) { clearInterval(wait); return; }
            if (f.state === 'ready') { clearInterval(wait); if (f.page === S.page) swapTo(f); }
          }, 200);
        }
        return;
      }
      f = spareFrame();
      showLoad(true, '正在切到第 ' + n + ' 页…');
      loadInto(f, n, function (ff) { if (ff.page === S.page) swapTo(ff); });
    }
    function isBoardPageAt(n) { return n > S.slides; }

    /* ==================================================================
     *  翻页 (画布与画面一起走)
     * ================================================================== */
    function total() { return S.slides + S.extra; }
    function goPage(n, quiet) {
      n = clamp(n | 0, 1, total());
      if (n === S.page && !quiet) { updatePageUI(); return; }
      S.page = n;
      S.selId = null;
      redraw();
      showSlide(n);
      updatePageUI();
      markFilm();
      saveSoon();
    }
    function nextPage() { goPage(S.page + 1); }
    function prevPage() { goPage(S.page - 1); }
    function addPage() {
      S.extra++;
      goPage(total());
      toast('已加板书页: 第 ' + S.page + ' 页 (在幻灯片之后, 可写满整屏)');
    }
    function updatePageUI() {
      var p = wrap.querySelector('#msPage');
      if (p) p.textContent = S.page + ' / ' + total();
      var t = wrap.querySelector('#msTitle');
      if (t) t.textContent = (S.meta.name || '课件') + (isBoardPage() ? ' · 板书页' : '');
      var sy = wrap.querySelector('#msSyncT');
      if (sy) {
        var isOcr = window.FLA_OCR && window.FLA_OCR.isCapturing();
        sy.textContent = isOcr ? 'AI 识屏同步' : '智能同步';
      }
    }

    /* ==================================================================
     *  撤销 / 重做 / 清除 / 橡皮
     * ================================================================== */
    function opPush(p, o) {
      (S.ops[p] = S.ops[p] || []).push(o);
      if (S.ops[p].length > 300) S.ops[p].shift();
      S.redos[p] = [];
      saveSoon();
    }
    function opApply(p, o, undo) {
      var arr = S.strokes[p] = S.strokes[p] || [];
      if (o.op === 'add') {
        if (undo) { var i = arr.indexOf(o.s); if (i >= 0) arr.splice(i, 1); } else arr.push(o.s);
      } else if (o.op === 'del') {
        if (undo) arr.push(o.s);
        else { var j = arr.indexOf(o.s); if (j >= 0) arr.splice(j, 1); }
      } else if (o.op === 'move') {
        var s = o.s, A = undo ? o.after : o.before, B = undo ? o.before : o.after;
        if (s.tool === 'text') s.pts = [B.slice()];
        else s.pts = B.map(function (q) { return q.slice(); });
        void A;
      } else if (o.op === 'clear') {
        if (undo) o.list.forEach(function (x) { arr.push(x); });
        else o.list.forEach(function (x) { var k = arr.indexOf(x); if (k >= 0) arr.splice(k, 1); });
      }
    }
    function undo() {
      var p = pid(), a = S.ops[p] || [];
      if (!a.length) { toast('这一页没有可撤销的板书'); return; }
      var o = a.pop(); opApply(p, o, true);
      (S.redos[p] = S.redos[p] || []).push(o);
      S.selId = null; redraw(); saveSoon();
    }
    function redo() {
      var p = pid(), a = S.redos[p] || [];
      if (!a.length) return;
      var o = a.pop(); opApply(p, o, false);
      (S.ops[p] = S.ops[p] || []).push(o);
      redraw(); saveSoon();
    }
    function clearPage() {
      var p = pid(), arr = S.strokes[p] || [];
      if (!arr.length) { toast('本页没有板书'); return; }
      opPush(p, { op: 'clear', list: arr.slice() });
      S.strokes[p] = []; S.selId = null; redraw();
      toast('已清空第 ' + S.page + ' 页板书 (Ctrl+Z 可撤销)');
    }
    function distToSeg(p, a, b) {
      var dx = b[0] - a[0], dy = b[1] - a[1];
      var l2 = dx * dx + dy * dy;
      if (!l2) return Math.hypot(p[0] - a[0], p[1] - a[1]);
      var t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
      return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
    }
    function erasePixelSeg(a, b, r) {
      var p = pid(), arr = S.strokes[p] || [];
      var changed = false, out = [];
      for (var i = 0; i < arr.length; i++) {
        var s = arr[i];
        var half = (s.width || 3) / 2;
        if (s.tool === 'shape' || s.tool === 'text') {
          var bx = bounds(s);
          if (a[0] >= bx.x0 - r && a[0] <= bx.x1 + r && a[1] >= bx.y0 - r && a[1] <= bx.y1 + r) {
            changed = true; opPush(p, { op: 'del', s: s }); continue;
          }
          out.push(s); continue;
        }
        if (!s.pts || !s.pts.length) continue;
        var touched = false, runs = [], curRun = [];
        for (var j = 0; j < s.pts.length; j++) {
          var pt = s.pts[j];
          var d = distToSeg(pt, a, b);
          if (d <= r + half) {
            touched = true;
            if (curRun.length) { runs.push(curRun); curRun = []; }
          } else {
            curRun.push(pt);
          }
        }
        if (curRun.length) runs.push(curRun);
        if (!touched) {
          out.push(s);
        } else {
          changed = true;
          opPush(p, { op: 'del', s: s });
          for (var k = 0; k < runs.length; k++) {
            if (runs[k].length > 0) {
              var piece = { id: uid(), tool: s.tool, color: s.color, width: s.width, pts: runs[k] };
              out.push(piece);
              opPush(p, { op: 'add', s: piece });
            }
          }
        }
      }
      if (changed) { S.strokes[p] = out; redraw(); }
    }
    function eraseAt(vx, vy) {
      var p = pid(), arr = S.strokes[p] || [], w = S.cfg.eraser.width;
      var r = w / 2 + 8, pt = [vx, vy], changed = false;
      for (var i = arr.length - 1; i >= 0; i--) {
        var s = arr[i], hit = false, b = bounds(s);
        var half = (s.width || 3) / 2;
        if (s.tool === 'shape' || s.tool === 'text') {
          hit = vx >= b.x0 - r && vx <= b.x1 + r && vy >= b.y0 - r && vy <= b.y1 + r;
        } else if (s.pts && s.pts.length) {
          if (s.pts.length === 1) {
            hit = Math.hypot(vx - s.pts[0][0], vy - s.pts[0][1]) <= r + half;
          } else {
            for (var j = 0; j < s.pts.length - 1; j++) {
              if (distToSeg(pt, s.pts[j], s.pts[j + 1]) <= r + half) { hit = true; break; }
            }
          }
        }
        if (hit) {
          arr.splice(i, 1); opPush(p, { op: 'del', s: s });
          if (S.selId === s.id) S.selId = null;
          changed = true;
        }
      }
      if (changed) redraw();
    }
    function pickAt(vx, vy) {
      var arr = S.strokes[pid()] || [];
      for (var i = arr.length - 1; i >= 0; i--) {
        var s = arr[i], b = bounds(s), pad = (s.tool === 'shape' || s.tool === 'text') ? 12 : 14 + (s.width || 3) / 2;
        if (vx >= b.x0 - pad && vx <= b.x1 + pad && vy >= b.y0 - pad && vy <= b.y1 + pad) return s;
      }
      return null;
    }

    /* ==================================================================
     *  输入 (指针事件 + 触摸)
     * ================================================================== */
    var textIn = null;
    function commitText() {
      if (!textIn) return;
      var txt = textIn.ta.value.replace(/\s+$/, ''), v = textIn.v;
      textIn.ta.remove(); textIn = null;
      if (!txt) return;
      var s = { id: uid(), tool: 'text', color: S.cfg.text.color, width: S.cfg.text.size, pts: [v], text: txt };
      (S.strokes[pid()] = S.strokes[pid()] || []).push(s);
      opPush(pid(), { op: 'add', s: s });
      redraw();
    }
    var ptDownTime = 0;
    var ptDownPos = [0, 0];
    var ptMovedDist = 0;
    var ptTapAddedStroke = null;

    ink.addEventListener('pointerdown', function (e) {
      if (S.tool === 'cursor') return;
      e.preventDefault();
      try { ink.setPointerCapture(e.pointerId); } catch (err) { }
      ptDownTime = Date.now();
      ptDownPos = [e.clientX, e.clientY];
      ptMovedDist = 0;
      ptTapAddedStroke = null;

      var v = toVirt(e.clientX, e.clientY);
      wakeUI();
      if (S.tool === 'laser') { S.laserDots.push({ x: v[0], y: v[1], t: Date.now() }); laserLoop(); return; }
      if (S.tool === 'eraser') {
        S.lastEraserPt = v;
        if (S.cfg.eraser.mode === 'pixel') erasePixelSeg(v, v, (S.cfg.eraser.width || 28) / 2);
        else eraseAt(v[0], v[1]);
        return;
      }
      if (S.tool === 'text') {
        commitText();
        var g = slideRect(), sc = g.w / VW;
        var ta = el('textarea', 'ms-textin');
        ta.style.left = (g.x + v[0] * sc) + 'px';
        ta.style.top = (g.y + v[1] * sc) + 'px';
        ta.style.fontSize = (S.cfg.text.size * sc) + 'px';
        ta.style.color = S.cfg.text.color;
        ta.rows = 1;
        wrap.appendChild(ta);
        setTimeout(function () { ta.focus(); }, 20);
        textIn = { ta: ta, v: v };
        ta.addEventListener('input', function () { ta.rows = Math.max(1, ta.value.split('\n').length); });
        ta.addEventListener('keydown', function (ev) {
          ev.stopPropagation();
          if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); commitText(); }
          else if (ev.key === 'Escape') { ta.remove(); textIn = null; }
        });
        ta.addEventListener('blur', function () { setTimeout(commitText, 120); });
        return;
      }
      if (S.tool === 'select') {
        var s0 = pickAt(v[0], v[1]);
        S.selId = s0 ? s0.id : null;
        if (s0) S.selOff = { s: s0, start: v, before: s0.pts.map(function (q) { return q.slice(); }) };
        redraw(); return;
      }
      if (S.tool === 'shape') {
        S.drawing = { id: uid(), tool: 'shape', shape: S.cfg.shape.type, color: S.cfg.shape.color,
                      width: S.cfg.shape.width, pts: [v, v.slice()] };
        return;
      }
      S.drawing = { id: uid(), tool: S.tool,
        color: S.tool === 'pen' ? S.cfg.pen.color : S.cfg.marker.color,
        width: S.tool === 'pen' ? S.cfg.pen.width : S.cfg.marker.width, pts: [v] };
      ptTapAddedStroke = S.drawing;
      (S.strokes[pid()] = S.strokes[pid()] || []).push(S.drawing);
      opPush(pid(), { op: 'add', s: S.drawing });
      redraw();
    });
    ink.addEventListener('pointermove', function (e) {
      if (S.tool === 'cursor') return;
      ptMovedDist += Math.abs(e.movementX || 0) + Math.abs(e.movementY || 0);
      var v = toVirt(e.clientX, e.clientY);
      if (S.tool === 'laser') { S.laserDots.push({ x: v[0], y: v[1], t: Date.now() }); laserLoop(); return; }
      if (S.tool === 'eraser') {
        if (e.buttons || e.pointerType === 'touch') {
          var prev = S.lastEraserPt || v;
          S.lastEraserPt = v;
          if (S.cfg.eraser.mode === 'pixel') erasePixelSeg(prev, v, (S.cfg.eraser.width || 28) / 2);
          else eraseAt(v[0], v[1]);
        }
        return;
      }
      if (S.tool === 'select' && S.selOff && (e.buttons || e.pointerType === 'touch')) {
        var s = S.selOff.s, dx = v[0] - S.selOff.start[0], dy = v[1] - S.selOff.start[1];
        s.pts = S.selOff.before.map(function (q) { return [q[0] + dx, q[1] + dy]; });
        redraw(); return;
      }
      if (!S.drawing) return;
      if (S.drawing.tool === 'shape') { S.drawing.pts[1] = v; redraw(S.drawing); return; }
      var L = S.drawing.pts[S.drawing.pts.length - 1];
      if (Math.abs(v[0] - L[0]) + Math.abs(v[1] - L[1]) < 1.1) return;
      S.drawing.pts.push(v);
      redraw();
    });
    function endStroke(e) {
      S.lastEraserPt = null;
      var wasTap = (Date.now() - ptDownTime < 320) && (ptMovedDist < 10);
      if (wasTap && e && typeof e.clientX === 'number') {
        var cx = e.clientX, cy = e.clientY;
        var isTopBar = cy < 70;
        var isBotBar = cy > window.innerHeight - 80;
        var isSideBar = cx < 70 || cx > window.innerWidth - 70;
        if (!isTopBar && !isBotBar && !isSideBar) {
          if (ptTapAddedStroke) {
            var arr = S.strokes[pid()] || [];
            var idx = arr.indexOf(ptTapAddedStroke);
            if (idx >= 0) arr.splice(idx, 1);
            var ops = S.ops[pid()] || [];
            if (ops.length && ops[ops.length - 1].s === ptTapAddedStroke) ops.pop();
            ptTapAddedStroke = null;
            S.drawing = null;
            redraw();
          }
          if (cx > window.innerWidth * 0.38) {
            triggerNext();
          } else {
            triggerPrev();
          }
        }
      }
      ptTapAddedStroke = null;

      if (S.drawing) {
        if (S.drawing.tool === 'shape') {
          var d = Math.abs(S.drawing.pts[1][0] - S.drawing.pts[0][0]) + Math.abs(S.drawing.pts[1][1] - S.drawing.pts[0][1]);
          if (d > 10) {
            (S.strokes[pid()] = S.strokes[pid()] || []).push(S.drawing);
            opPush(pid(), { op: 'add', s: S.drawing });
          }
        }
        S.drawing = null; redraw(); saveSoon();
      }
      if (S.selOff) {
        var s = S.selOff.s, after = s.pts.map(function (q) { return q.slice(); });
        if (JSON.stringify(after) !== JSON.stringify(S.selOff.before)) {
          opPush(pid(), { op: 'move', s: s, before: S.selOff.before, after: after });
        }
        S.selOff = null; saveSoon();
      }
      focusIframe();
    }
    }
    ink.addEventListener('pointerup', endStroke);
    ink.addEventListener('pointercancel', endStroke);
    ink.addEventListener('pointerleave', function () { if (S.drawing) endStroke(); });

    /* 激光笔 */
    var laserOn = false;
    function laserLoop() {
      if (laserOn) return;
      laserOn = true;
      (function loop() {
        if (S.dead) { laserOn = false; return; }
        requestAnimationFrame(loop);
        if (!S.laserDots.length && S.tool !== 'laser') {
          lctx.setTransform(1, 0, 0, 1, 0, 0); lctx.clearRect(0, 0, laser.width, laser.height);
          laserOn = false; return;
        }
        var now = Date.now(), g = slideRect();
        S.laserDots = S.laserDots.filter(function (d) { return now - d.t < 700; });
        lctx.setTransform(1, 0, 0, 1, 0, 0);
        lctx.clearRect(0, 0, laser.width, laser.height);
        lctx.save();
        lctx.scale(S.dpr, S.dpr);
        lctx.translate(g.x, g.y); lctx.scale(g.w / VW, g.h / VH);
        for (var i = 0; i < S.laserDots.length; i++) {
          var d = S.laserDots[i], age = (now - d.t) / 700;
          lctx.beginPath();
          lctx.fillStyle = 'rgba(239,68,68,' + (1 - age * .85) + ')';
          lctx.shadowColor = 'rgba(239,68,68,.9)'; lctx.shadowBlur = 18;
          lctx.arc(d.x, d.y, 8 - age * 5, 0, Math.PI * 2); lctx.fill();
        }
        lctx.restore();
      })();
    }

    /* ==================================================================
     *  工具切换 + 配置弹窗
     * ================================================================== */
    function setTool(t) {
      commitText();
      S.tool = t;
      ink.style.pointerEvents = (t === 'cursor') ? 'none' : 'auto';
      ink.style.cursor = t === 'cursor' ? 'default' : (t === 'eraser' ? 'cell' : (t === 'select' ? 'default' : 'crosshair'));
      if (t !== 'select') { S.selId = null; redraw(); }
      if (t !== 'laser') { S.laserDots = []; }
      Array.prototype.forEach.call(barL.querySelectorAll('[data-tool]'), function (b) {
        b.classList.toggle('on', b.getAttribute('data-tool') === t);
      });
      pop.classList.add('hidden');
      wakeUI();
      stSet('fla_ms_tool', t);
    }
    function swatchRow(colors, cur, onpick) {
      var row = el('div', 'ms-pop-row');
      colors.forEach(function (c) {
        var b = el('button', 'ms-sw' + (c === cur ? ' on' : ''));
        b.style.background = c;
        b.onclick = function () {
          onpick(c);
          Array.prototype.forEach.call(row.querySelectorAll('.ms-sw'), function (x) { x.classList.remove('on'); });
          b.classList.add('on'); saveCfg();
        };
        row.appendChild(b);
      });
      var lab = el('label', 'ms-sw ms-cus'); lab.title = '自定义颜色';
      var ci = el('input'); ci.type = 'color'; ci.value = cur;
      ci.oninput = function () { onpick(ci.value); saveCfg(); };
      lab.appendChild(ci); row.appendChild(lab);
      return row;
    }
    function sliderRow(name, min, max, val, on) {
      var row = el('div', 'ms-pop-row');
      var lb = el('span', 'ms-pop-lb'); lb.textContent = name;
      var rg = el('input'); rg.type = 'range'; rg.min = min; rg.max = max; rg.value = val; rg.className = 'ms-range';
      var vb = el('b', 'ms-pop-val'); vb.textContent = val;
      rg.oninput = function () { vb.textContent = rg.value; on(+rg.value); saveCfg(); redraw(); };
      row.appendChild(lb); row.appendChild(rg); row.appendChild(vb);
      return row;
    }
    function saveCfg() { stSet('fla_ms_cfg', JSON.stringify(S.cfg)); }
    function buildPop(t) {
      pop.innerHTML = '';
      if (t === 'pen') {
        pop.appendChild(swatchRow(PEN_COLORS, S.cfg.pen.color, function (c) { S.cfg.pen.color = c; }));
        pop.appendChild(sliderRow('粗细', 1, 14, S.cfg.pen.width, function (v) { S.cfg.pen.width = v; }));
      } else if (t === 'marker') {
        pop.appendChild(swatchRow(MARKER_COLORS, S.cfg.marker.color, function (c) { S.cfg.marker.color = c; }));
        pop.appendChild(sliderRow('粗细', 6, 40, S.cfg.marker.width, function (v) { S.cfg.marker.width = v; }));
      } else if (t === 'shape') {
        var r = el('div', 'ms-pop-row');
        SHAPE_LIST.forEach(function (sh) {
          var b = el('button', 'ms-shape' + (S.cfg.shape.type === sh[0] ? ' on' : ''));
          b.title = sh[1]; b.innerHTML = svgEl(22, 22, SHAPE_MINI[sh[0]]);
          b.onclick = function () {
            S.cfg.shape.type = sh[0]; saveCfg();
            Array.prototype.forEach.call(r.querySelectorAll('.ms-shape'), function (x) { x.classList.remove('on'); });
            b.classList.add('on');
          };
          r.appendChild(b);
        });
        pop.appendChild(r);
        pop.appendChild(swatchRow(SHAPE_COLORS, S.cfg.shape.color, function (c) { S.cfg.shape.color = c; }));
        pop.appendChild(sliderRow('粗细', 1, 14, S.cfg.shape.width, function (v) { S.cfg.shape.width = v; }));
      } else if (t === 'text') {
        pop.appendChild(swatchRow(TEXT_COLORS, S.cfg.text.color, function (c) { S.cfg.text.color = c; }));
        pop.appendChild(sliderRow('字号', 14, 90, S.cfg.text.size, function (v) { S.cfg.text.size = v; }));
        var h = el('p', 'ms-pop-hint'); h.textContent = '点击画面输入, Enter 确认, Shift+Enter 换行';
        pop.appendChild(h);
      } else if (t === 'eraser') {
        var modeRow = el('div', 'ms-pop-row ms-seg-row');
        modeRow.innerHTML =
          '<button class="ms-seg-b' + (S.cfg.eraser.mode !== 'pixel' ? ' on' : '') + '" data-em="object">对象橡皮</button>' +
          '<button class="ms-seg-b' + (S.cfg.eraser.mode === 'pixel' ? ' on' : '') + '" data-em="pixel">像素橡皮</button>';
        var hint = el('p', 'ms-pop-hint');
        function updateEraserHint() {
          hint.textContent = S.cfg.eraser.mode === 'pixel'
            ? '像素橡皮：精细局部擦除，划过哪截切断哪截 · 设定下方粗细'
            : '对象橡皮：碰触整条笔画删除 · 适合快速清掉整行字或图形';
        }
        updateEraserHint();
        Array.prototype.forEach.call(modeRow.querySelectorAll('button'), function (b) {
          b.onclick = function () {
            S.cfg.eraser.mode = b.getAttribute('data-em');
            saveCfg();
            Array.prototype.forEach.call(modeRow.querySelectorAll('button'), function (x) { x.classList.remove('on'); });
            b.classList.add('on');
            updateEraserHint();
          };
        });
        pop.appendChild(modeRow);
        pop.appendChild(sliderRow('粗细 / 大小', 6, 120, S.cfg.eraser.width || 28, function (v) { S.cfg.eraser.width = v; }));
        var clearBtn = el('button', 'btn danger block');
        clearBtn.textContent = '清空本页板书';
        clearBtn.style.marginTop = '10px';
        clearBtn.onclick = function () { clearPage(); pop.classList.add('hidden'); };
        pop.appendChild(clearBtn);
        pop.appendChild(hint);
      } else { pop.classList.add('hidden'); return; }
      pop.setAttribute('data-tool', t);
      pop.classList.remove('hidden');
    }

    /* ==================================================================
     *  板书区域微调 (对准微软画面里的幻灯片)
     * ================================================================== */
    function enterAlign() {
      var g = slideRect(), v = viewport();
      S.align = { x: g.x / v.w, y: g.y / v.h, w: g.w / v.w, h: g.h / v.h, drag: null };
      rectGuide.classList.remove('hidden');
      paintAlign();
      toast('拖动中间移动板书区域, 拖四角缩放; 完成后点「完成对齐」', 6000);
      var bar = el('div', 'ms-alignbar');
      bar.innerHTML = '<button data-x="ok">完成对齐</button><button data-x="auto">恢复自动</button>' +
        '<button data-x="wide">铺满全屏</button><span>板书区域将保存在这个课件上, 换设备也一致</span>';
      bar.className = 'ms-alignbar';
      wrap.appendChild(bar);
      S.alignBar = bar;
      bar.onclick = function (e) {
        var b = e.target.closest('[data-x]'); if (!b) return;
        var v2 = viewport();
        if (b.getAttribute('data-x') === 'auto') S.rect = null;
        else if (b.getAttribute('data-x') === 'wide') S.rect = [0, 0, 1, 1];
        else S.rect = [S.align.x, S.align.y, S.align.w, S.align.h];
        exitAlign(); redraw(); saveSoon();
      };
      setTool('cursor');
    }
    function paintAlign() {
      var v = viewport(), a = S.align;
      rectGuide.style.left = (a.x * v.w) + 'px';
      rectGuide.style.top = (a.y * v.h) + 'px';
      rectGuide.style.width = (a.w * v.w) + 'px';
      rectGuide.style.height = (a.h * v.h) + 'px';
    }
    function exitAlign() {
      rectGuide.classList.add('hidden');
      if (S.alignBar) { S.alignBar.remove(); S.alignBar = null; }
      S.align = null;
    }
    rectGuide.addEventListener('pointerdown', function (e) {
      if (!S.align) return;
      e.preventDefault();
      var v = viewport(), r = rectGuide.getBoundingClientRect();
      var edge = 22, x = e.clientX, y = e.clientY;
      var mode = '';
      if (Math.abs(x - r.left) < edge) mode += 'w';
      if (Math.abs(x - r.right) < edge) mode += 'e';
      if (Math.abs(y - r.top) < edge) mode += 'n';
      if (Math.abs(y - r.bottom) < edge) mode += 's';
      S.align.drag = { mode: mode || 'move', sx: x / v.w, sy: y / v.h, o: { x: S.align.x, y: S.align.y, w: S.align.w, h: S.align.h } };
      try { rectGuide.setPointerCapture(e.pointerId); } catch (err) { }
    });
    rectGuide.addEventListener('pointermove', function (e) {
      if (!S.align || !S.align.drag) return;
      var v = viewport(), d = S.align.drag, o = d.o;
      var dx = e.clientX / v.w - d.sx, dy = e.clientY / v.h - d.sy;
      if (d.mode === 'move') { S.align.x = clamp(o.x + dx, 0, 1 - o.w); S.align.y = clamp(o.y + dy, 0, 1 - o.h); }
      else {
        if (d.mode.indexOf('e') >= 0) S.align.w = clamp(o.w + dx, .1, 1 - o.x);
        if (d.mode.indexOf('s') >= 0) S.align.h = clamp(o.h + dy, .08, 1 - o.y);
        if (d.mode.indexOf('w') >= 0) { var nw = clamp(o.w - dx, .1, o.x + o.w); S.align.x = o.x + o.w - nw; S.align.w = nw; }
        if (d.mode.indexOf('n') >= 0) { var nh = clamp(o.h - dy, .08, o.y + o.h); S.align.y = o.y + o.h - nh; S.align.h = nh; }
      }
      paintAlign();
      S.rect = [S.align.x, S.align.y, S.align.w, S.align.h];
      redraw();
    });
    rectGuide.addEventListener('pointerup', function () { if (S.align) S.align.drag = null; });

    /* ==================================================================
     *  缩略图导航 (pdf.js 渲染服务端转出的 PDF; 失败则退化成数字格子)
     * ================================================================== */
    function toggleFilm(force) {
      var on = force === undefined ? film.classList.contains('hidden') : force;
      film.classList.toggle('hidden', !on);
      var topF = top.querySelector('[data-a=film]');
      if (topF) topF.classList.toggle('on', on);
      var sideF = barR.querySelector('[data-a=film]');
      if (sideF) sideF.classList.toggle('on', on);
      if (on) { buildFilm(); wakeUI(); }
    }
    function buildFilm() {
      if (film.getAttribute('data-n') === String(total()) && film.childNodes.length > 1) { markFilm(); return; }
      film.innerHTML = '<div class="ms-film-head"><b>页面导航</b>' +
        '<span>点缩略图直接跳页 — 板书会跟着切到该页</span>' +
        '<button class="ms-tb" data-f="close">✕</button></div><div class="ms-film-list" id="msFilmList"></div>';
      film.setAttribute('data-n', String(total()));
      film.querySelector('[data-f=close]').onclick = function () { toggleFilm(false); };
      var list = film.querySelector('#msFilmList');
      for (var i = 1; i <= total(); i++) {
        (function (n) {
          var c = el('button', 'ms-thumb');
          c.setAttribute('data-p', n);
          c.innerHTML = '<span class="ms-thumb-img" id="th' + n + '">' +
            (n > S.slides ? '<i class="ms-thumb-board">板</i>' : '<i class="ms-thumb-no">' + n + '</i>') + '</span>' +
            '<span class="ms-thumb-cap">' + (n > S.slides ? '板书页' : '第 ' + n + ' 页') +
            '<em class="ms-thumb-ink hidden">✎</em></span>';
          c.onclick = function () { goPage(n); };
          list.appendChild(c);
        })(i);
      }
      markFilm();
      renderThumbs();
    }
    function markFilm() {
      if (film.classList.contains('hidden')) return;
      Array.prototype.forEach.call(film.querySelectorAll('.ms-thumb'), function (c) {
        var n = +c.getAttribute('data-p');
        c.classList.toggle('on', n === S.page);
        var key = n <= S.slides ? 'm' + (n - 1) : 'x' + (n - S.slides - 1);
        var hasInk = (S.strokes[key] || []).length > 0;
        var e = c.querySelector('.ms-thumb-ink');
        if (e) e.classList.toggle('hidden', !hasInk);
      });
      var cur = film.querySelector('.ms-thumb.on');
      if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    function renderThumbs() {
      if (S.pdfBusy || S.pdf === false) return;
      S.pdfBusy = true;
      loadScript('/lib/pdfjs/pdf.min.js').then(function () {
        var lib = window.pdfjsLib;
        lib.GlobalWorkerOptions.workerSrc = '/lib/pdfjs/pdf.worker.min.js';
        return lib.getDocument({ url: '/api/files/' + S.fid + '/pdf', httpHeaders: AUTH }).promise;
      }).then(function (doc) {
        S.pdf = doc;
        var n = Math.min(doc.numPages, S.slides);
        var i = 1;
        (function next() {
          if (S.dead || i > n) { S.pdfBusy = false; return; }
          doc.getPage(i).then(function (pg) {
            var k = 200 / pg.getViewport({ scale: 1 }).width;
            var vp = pg.getViewport({ scale: k });
            var cv = document.createElement('canvas');
            cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
            return pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise.then(function () { return cv; });
          }).then(function (cv) {
            var box = film.querySelector('#th' + i);
            if (box) {
              box.innerHTML = '';
              var img = document.createElement('img');
              img.src = cv.toDataURL('image/jpeg', .72);
              box.appendChild(img);
            }
            S.thumbs[i] = 1;
          }).catch(function () { }).then(function () {
            i++; setTimeout(next, 60);
          });
        })();
      }).catch(function () { S.pdf = false; S.pdfBusy = false; });
    }
    function loadScript(src) {
      return new Promise(function (res, rej) {
        if (document.querySelector('script[data-ms="' + src + '"]')) return res();
        var s = document.createElement('script');
        s.src = src; s.setAttribute('data-ms', src);
        s.onload = function () { res(); };
        s.onerror = function () { rej(new Error('组件加载失败: ' + src)); };
        document.head.appendChild(s);
      });
    }

    /* ==================================================================
     *  板中板 (独立小黑板, 不干扰主画面)
     * ================================================================== */
    function bbPid() { return 'bb' + S.bbCur; }
    function bbGeom() {
      var r = bbCv.getBoundingClientRect();
      var k = Math.min(r.width / VW, (r.height - 4) / VH);
      return { k: k, ox: (r.width - VW * k) / 2, oy: (r.height - VH * k) / 2 };
    }
    function bbRedraw() {
      var pg = bnb.querySelector('#bbPg');
      if (pg) pg.textContent = (S.bbCur + 1) + ' / ' + S.bbN;
      var r = bbCv.getBoundingClientRect();
      if (r.width < 4) return;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (bbCv.width !== Math.round(r.width * dpr)) { bbCv.width = Math.round(r.width * dpr); bbCv.height = Math.round(r.height * dpr); }
      var c = bbCv.getContext('2d'), g = bbGeom();
      c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, bbCv.width, bbCv.height);
      c.save(); c.scale(dpr, dpr); c.translate(g.ox, g.oy); c.scale(g.k, g.k);
      (S.strokes[bbPid()] || []).forEach(function (s) { drawStroke(c, s); });
      c.restore();
    }
    function bbPt(e) {
      var r = bbCv.getBoundingClientRect(), g = bbGeom();
      return [(e.clientX - r.left - g.ox) / g.k, (e.clientY - r.top - g.oy) / g.k];
    }
    var bbDraw = null;
    function bbPush(op) {
      var p = bbPid();
      (S.bbOps[p] = S.bbOps[p] || []).push(op);
      if (S.bbOps[p].length > 200) S.bbOps[p].shift();
      S.bbRedos[p] = [];
      saveSoon();
    }
    bbCv.addEventListener('pointerdown', function (e) {
      e.preventDefault(); e.stopPropagation();
      try { bbCv.setPointerCapture(e.pointerId); } catch (err) { }
      var p = bbPt(e);
      if (S.tool === 'eraser') {
        var arr = S.strokes[bbPid()] || [];
        for (var i = arr.length - 1; i >= 0; i--) {
          var s = arr[i];
          if ((s.pts || []).some(function (q) { return Math.abs(q[0] - p[0]) < 16 && Math.abs(q[1] - p[1]) < 16; })) {
            arr.splice(i, 1); bbPush({ op: 'del', s: s }); bbRedraw(); return;
          }
        }
        return;
      }
      var t = (S.tool === 'marker') ? 'marker' : 'pen';
      bbDraw = { id: uid(), tool: t,
        color: t === 'marker' ? S.cfg.marker.color : S.cfg.pen.color,
        width: t === 'marker' ? S.cfg.marker.width : S.cfg.pen.width, pts: [p] };
      (S.strokes[bbPid()] = S.strokes[bbPid()] || []).push(bbDraw);
      bbPush({ op: 'add', s: bbDraw });
      bbRedraw();
    });
    bbCv.addEventListener('pointermove', function (e) {
      if (!bbDraw) return;
      var p = bbPt(e), L = bbDraw.pts[bbDraw.pts.length - 1];
      if (Math.abs(p[0] - L[0]) + Math.abs(p[1] - L[1]) < 1.4) return;
      bbDraw.pts.push(p); bbRedraw();
    });
    function bbEnd() { bbDraw = null; bbRedraw(); saveSoon(); }
    bbCv.addEventListener('pointerup', bbEnd);
    bbCv.addEventListener('pointercancel', bbEnd);
    bnb.querySelector('.ms-bnb-bar').onclick = function (e) {
      var b = e.target.closest('[data-b]'); if (!b) return;
      var a = b.getAttribute('data-b');
      if (a === 'close') toggleBnb(false);
      else if (a === 'prev') { if (S.bbCur > 0) { S.bbCur--; bbRedraw(); saveSoon(); } }
      else if (a === 'next') { if (S.bbCur < S.bbN - 1) { S.bbCur++; bbRedraw(); saveSoon(); } }
      else if (a === 'add') { S.bbN++; S.bbCur = S.bbN - 1; bbRedraw(); saveSoon(); toast('板中板已加页: ' + S.bbN + ' 页'); }
      else if (a === 'clear') {
        var p = bbPid(), arr = S.strokes[p] || [];
        if (arr.length) { bbPush({ op: 'clear', list: arr.slice() }); S.strokes[p] = []; bbRedraw(); }
      }
    };
    function toggleBnb(force) {
      S.bbOpen = force === undefined ? !S.bbOpen : force;
      bnb.classList.toggle('on', S.bbOpen);
      barR.querySelector('[data-a=bnb]').classList.toggle('on', S.bbOpen);
      if (S.bbOpen) setTimeout(bbRedraw, 260);
    }

    /* ==================================================================
     *  同步模式 / 首次对齐自检
     * ================================================================== */
    function setSync(m, quiet) {
      S.sync = m; stSet('fla_ms_sync', m);
      updatePageUI();
      if (m === 'deep') {
        /* 切回我方驱动: 立刻把微软画面拉到当前页 */
        S.frames.forEach(function (f) { f.page = 0; f.state = 'idle'; });
        showSlide(S.page);
        if (!quiet) toast('我方驱动: ‹ › / 缩略图 / 数字键 直接翻页, 板书同步切换', 4200);
      } else {
        if (!quiet) toast('微软自翻: 点微软画面翻页(原生动画最顺), 板书用 ‹ › 或 Ctrl+← → 对齐', 6500);
      }
    }
    function syncMenu() {
      var isOcr = window.FLA_OCR && window.FLA_OCR.isCapturing();
      var m = dlg({
        title: '放映同步与 AI 识屏设定',
        html: '<div class="ms-sync-list">' +
          '<button data-s="ocr" class="' + (isOcr ? 'on' : '') + '">' +
          '<b>📷 AI 识屏实时同步（推荐 · 免选自翻/微软）</b>' +
          '<span>智能提取微软下方「第N张幻灯片，共M张」文字，板书毫秒随动翻页。<br>' +
          (isOcr ? '<span style="color:#10b981;font-weight:bold">● 当前正在运行中（点击可关闭）</span>' : '点击开启后，在浏览器弹窗中选择当前标签页即可。') +
          '</span></button>' +
          '<button data-s="smart" class="' + (!isOcr ? 'on' : '') + '">' +
          '<b>⚡ 双向智能同步 + 翻页笔穿透</b>' +
          '<span>手持激光笔 (PageDown/Up) 与键盘直接翻页，支持右下角胶囊快速对齐与 Tab 快捷键。</span></button>' +
          '<button data-s="local"><b>本地引擎（离线）</b><span>不用微软: 服务器转出的高保真页面 + 元素级动画, 断网也能上, 板书天然随页。</span></button>' +
          '</div>' +
          '<p class="ms-pop-hint">提示：在右下角常驻胶囊中，也可随时点击【📷 识屏】开启或按【Tab】一键同步。</p>',
        onMount: function (body, close) {
          body.querySelectorAll('[data-s]').forEach(function (b) {
            b.onclick = function () {
              var v = b.getAttribute('data-s');
              if (v === 'local') { close(); goLocal(); return; }
              if (v === 'ocr') { close(); toggleOcrSync(); return; }
              if (v === 'smart') {
                if (window.FLA_OCR && window.FLA_OCR.isCapturing()) window.FLA_OCR.stopCapture();
                close();
                toast('已设为双向智能同步模式', 2000);
                updatePill();
                return;
              }
              close();
            };
          });
        }
      });
      return m;
    }
    function selfTest() {
      if (S.slides < 2) { toast('这份文档只有 1 页, 无需自检'); return; }
      setSync('deep', true);
      goPage(2);
      var d = el('div', 'ms-selftest');
      d.innerHTML = '<div class="ms-st-card"><b>请看投影画面</b>' +
        '<p>微软画面现在显示的是<strong>第 2 页</strong>吗?</p>' +
        '<div class="ms-st-row"><button data-r="yes">是, 画面跟着跳了 ✔</button>' +
        '<button data-r="no">不是, 画面还在第 1 页</button></div></div>';
      wrap.appendChild(d);
      d.onclick = function (e) {
        var b = e.target.closest('[data-r]'); if (!b) return;
        var ok = b.getAttribute('data-r') === 'yes';
        d.remove();
        if (ok) {
          stSet('fla_ms_sync_ok', '1'); setSync('deep', true);
          toast('很好 — 已锁定「我方驱动」, 板书会严格随页切换', 4000);
        } else {
          setSync('follow', true);
          toast('已切到「微软自翻 + 板书对齐」: 点微软画面翻页, 板书用 ‹ › 对齐', 8000);
        }
        goPage(1);
      };
    }
    /* 首次使用提示: 让老师确认微软画面确实跟着翻页(不确认就自动切 follow) */
    function hintCheck() {
      var d = el('div', 'ms-hint-check');
      d.innerHTML = '<b>板书随页自检</b>' +
        '<p>翻一页看看: 微软画面是否跟着跳到同一页?</p>' +
        '<div class="ms-hc-row"><button data-r="test">现在翻到第 2 页试试</button>' +
        '<button data-r="ok">一直是同步的, 不再提示</button>' +
        '<button data-r="no">画面没跟着跳 → 换跟随模式</button></div>';
      wrap.appendChild(d);
      requestAnimationFrame(function () { d.classList.add('on'); });
      d.onclick = function (e) {
        var b = e.target.closest('[data-r]'); if (!b) return;
        var r = b.getAttribute('data-r');
        d.classList.remove('on');
        setTimeout(function () { d.remove(); }, 300);
        stSet('fla_ms_done_check', '1');
        if (r === 'test') selfTest();
        else if (r === 'ok') { stSet('fla_ms_sync_ok', '1'); toast('已确认: 板书严格随页切换'); }
        else { setSync('follow'); }
      };
      setTimeout(function () {
        if (d.parentNode) { d.classList.remove('on'); setTimeout(function () { d.remove(); }, 300); }
      }, 45000);
    }

    function goLocal() {
      var u = '/present.html?fid=' + S.fid + '&token=' + encodeURIComponent(S.token);
      saveNow();
      if (S.mode === 'view') window.open(u, '_blank');
      else location.href = u;
    }

    /* 轻量弹窗(放映页是独立文档, 没有主页面的 UI.modal) */
    function dlg(o) {
      var ov = el('div', 'ms-modal-ovl');
      var box = el('div', 'ms-modal');
      box.innerHTML = '<div class="ms-modal-h"><b>' + o.title + '</b><button class="ms-tb" data-c>✕</button></div>' +
        '<div class="ms-modal-b">' + o.html + '</div>';
      ov.appendChild(box);
      wrap.appendChild(ov);
      var body = box.querySelector('.ms-modal-b');
      function close() { ov.remove(); }
      box.querySelector('[data-c]').onclick = close;
      ov.onclick = function (e) { if (e.target === ov) close(); };
      if (o.onMount) o.onMount(body, close);
      return { close: close, el: ov };
    }

    /* ==================================================================
     *  提示条
     * ================================================================== */
    function toast(msg, dur) {
      var t = el('div', 'ms-toast'); t.textContent = msg;
      toasts.appendChild(t);
      requestAnimationFrame(function () { t.classList.add('on'); });
      setTimeout(function () {
        t.classList.remove('on');
        setTimeout(function () { t.remove(); }, 360);
      }, dur || 2800);
    }

    /* ==================================================================
     *  UI 自动隐藏 / 计时 / 全屏
     * ================================================================== */
    function wakeUI() {
      wrap.classList.remove('idle');
      clearTimeout(S.hideT);
      if (S.keepToolbar) return;   /* 常驻模式: 老师上课工具栏不收起 */
      if (S.mode === 'present') {
        S.hideT = setTimeout(function () {
          if (S.tool === 'cursor' && !S.bbOpen && pop.classList.contains('hidden')) wrap.classList.add('idle');
        }, 4200);
      }
    }
    wrap.addEventListener('mousemove', wakeUI);
    wrap.addEventListener('pointerdown', wakeUI);
    function toggleFull() {
      var d = document;
      if (d.fullscreenElement || d.webkitFullscreenElement) {
        (d.exitFullscreen || d.webkitExitFullscreen || function () { }).call(d);
      } else {
        var e = wrap, fn = e.requestFullscreen || e.webkitRequestFullscreen;
        if (fn) { try { fn.call(e); } catch (err) { } }
        else {
          fn = d.documentElement.requestFullscreen || d.documentElement.webkitRequestFullscreen;
          if (fn) { try { fn.call(d.documentElement); } catch (err2) { } }
        }
      }
    }
    S._clock = setInterval(function () {
      if (S.dead) return;
      var t = wrap.querySelector('#msTime');
      if (t) t.textContent = fmtT(Math.floor((Date.now() - S.t0) / 1000));
    }, 1000);

    /* ==================================================================
     *  按钮事件 (委托)
     * ================================================================== */
    wrap.addEventListener('click', function (e) {
      var tb = e.target.closest('[data-tool]');
      if (tb && barL.contains(tb)) {
        var t = tb.getAttribute('data-tool');
        if (t === 'cursor') { setTool('cursor'); return; }
        if (S.tool === t) {
          if (pop.classList.contains('hidden') || pop.getAttribute('data-tool') !== t) buildPop(t);
          else pop.classList.add('hidden');
        } else setTool(t);
        return;
      }
      var b = e.target.closest('[data-a]');
      if (!b) return;
      var a = b.getAttribute('data-a');
      switch (a) {
        case 'exit': doExit(); break;
        case 'prev': case 'pgprev': triggerPrev(); break;
        case 'next': case 'pgnext': triggerNext(); break;
        case 'addpage': addPage(); break;
        case 'undo': undo(); break;
        case 'redo': redo(); break;
        case 'clear': clearPage(); break;
        case 'bnb': toggleBnb(); break;
        case 'bg':
          S.cfg.boardBg = S.cfg.boardBg === 'w' ? 'k' : (S.cfg.boardBg === 'k' ? 'g' : 'w');
          saveCfg(); redraw();
          toast('板书底色: ' + ({ w: '白板', k: '黑板', g: '绿黑板' })[S.cfg.boardBg]);
          break;
        case 'black': blk.classList.toggle('hidden'); break;
        case 'local': goLocal(); break;
        case 'present':
          window.open('/present.html?fid=' + S.fid + '&token=' + encodeURIComponent(S.token) + '&track=ms', '_blank');
          break;
        case 'refresh':
          showLoad(true, '正在重新载入微软画面…');
          for (var ri = 0; ri < S.frames.length; ri++) {
            S.frames[ri].token++; S.frames[ri].page = 0; S.frames[ri].state = 'idle';
            S.frames[ri].style.opacity = '0';
          }
          S.fcur = -1;
          goPage(S.page, true);
          toast('已重新载入; 微软侧转换缓存偶尔需要 1–2 分钟才刷新', 5000);
          break;
        case 'dl':
          window.open('/api/files/' + S.fid + '/download?token=' + encodeURIComponent(S.token), '_blank');
          break;
        case 'film': toggleFilm(); break;
        case 'sync': syncMenu(); break;
        case 'pin':
          S.keepToolbar = !S.keepToolbar;
          stSet('fla_keep_toolbar', S.keepToolbar ? '1' : '0');
          var pinEl = wrap.querySelector('#msPin');
          if (pinEl) {
            pinEl.classList.toggle('on', S.keepToolbar);
            var pinT = pinEl.querySelector('#msPinTxt');
            if (pinT) pinT.textContent = S.keepToolbar ? '工具栏常驻' : '自动收起';
          }
          wakeUI();
          toast(S.keepToolbar ? '已开启【工具栏常驻】(上课不收回)' : '已恢复【自动收起】(移至屏幕边缘唤出)');
          break;
        case 'align': S.align ? exitAlign() : enterAlign(); break;
        case 'time': S.t0 = Date.now(); break;
        case 'full': toggleFull(); break;
      }
    });
    wrap.querySelector('#msPage').onclick = function () {
      var m = dlg({
        title: '跳到第几页',
        html: '<div class="ms-goto"><input type="number" min="1" max="' + total() + '" value="' + S.page + '">' +
          '<span>/ ' + total() + ' 页 (幻灯片 ' + S.slides + ' 页 + 板书页 ' + S.extra + ' 页)</span></div>' +
          '<div class="ms-goto-grid" id="msGotoGrid"></div>',
        onMount: function (body, close) {
          var inp = body.querySelector('input');
          inp.focus(); inp.select();
          inp.onkeydown = function (ev) {
            if (ev.key === 'Enter') { goPage(+inp.value || 1); close(); }
          };
          var g = body.querySelector('#msGotoGrid');
          for (var i = 1; i <= total(); i++) {
            (function (n) {
              var b = el('button', 'ms-goto-n' + (n === S.page ? ' on' : ''));
              b.textContent = n;
              b.onclick = function () { goPage(n); close(); };
              g.appendChild(b);
            })(i);
          }
          var bb = el('button', 'btn primary');
          bb.textContent = '跳到第 ' + total() + ' 页并加一页板书';
          bb.style.marginTop = '12px';
          bb.onclick = function () { addPage(); close(); };
          body.appendChild(bb);
        }
      });
      return m;
    };
    blk.onclick = function () { blk.classList.add('hidden'); };

    function doExit() {
      saveNow();
      if (opts.onExit) { opts.onExit(); return; }
      try { window.close(); } catch (e) { }
      if (window.history.length > 1) window.history.back();
    }

    /* ==================================================================
     *  浮动常驻同步胶囊 (微软放映跟随/对齐/AI 识屏)
     * ================================================================== */
    var syncPill = el('div', 'ms-sync-pill');
    syncPill.innerHTML =
      '<button class="msp-b" data-sp="prev" title="上一页 (PageUp)">‹</button>' +
      '<span class="msp-txt" id="mspText">第 1 / ' + (S.slides || 1) + ' 页</span>' +
      '<button class="msp-b" data-sp="next" title="下一页 (PageDown)">›</button>' +
      '<button class="msp-ocr" data-sp="ocr" title="AI 文字识别: 自动识别微软底部「第N张幻灯片，共M张」">📷 识屏</button>' +
      '<button class="msp-sync" data-sp="sync" title="点击或按 Tab 一键同步板书">同步</button>';
    wrap.appendChild(syncPill);

    function updatePill() {
      var txt = syncPill.querySelector('#mspText');
      if (txt) {
        var isOcr = window.FLA_OCR && window.FLA_OCR.isCapturing();
        var stepCount = getSlideStepCount(S.page);
        if (isOcr) {
          txt.textContent = '🟢 识屏 第 ' + S.page + ' / ' + total() + ' 页';
        } else if (S.sync === 'follow' && stepCount > 0) {
          txt.textContent = '第 ' + S.page + ' / ' + total() + ' 页 · 动 ' + S.stepInSlide + '/' + stepCount;
        } else {
          txt.textContent = '第 ' + S.page + ' / ' + total() + ' 页';
        }
      }
      var ocrBtn = syncPill.querySelector('[data-sp=ocr]');
      if (ocrBtn) {
        var capturing = window.FLA_OCR && window.FLA_OCR.isCapturing();
        ocrBtn.classList.toggle('active', !!capturing);
        ocrBtn.innerHTML = capturing ? '🟢 识屏中' : '📷 识屏';
      }
    }

    async function toggleOcrSync() {
      if (!window.FLA_OCR) {
        toast('文字识别模块正在加载中，请稍候...', 2000);
        return;
      }
      var ocrBtn = syncPill.querySelector('[data-sp=ocr]');
      if (window.FLA_OCR.isCapturing()) {
        window.FLA_OCR.stopCapture();
        if (ocrBtn) {
          ocrBtn.classList.remove('active');
          ocrBtn.innerHTML = '📷 识屏';
        }
        toast('已停止 AI 识屏同步');
        updatePill();
        return;
      }

      toast('正在开启 AI 识屏… 请在浏览器弹窗中选择当前标签页', 4000);
      try {
        await window.FLA_OCR.startCapture({
          onPage: function (res) {
            if (S.dead) return;
            var target = res.cur;
            if (target >= 1 && target <= total() && target !== S.page) {
              goPage(target, true);
              toast('AI 识屏同步: 第 ' + target + ' 页 ✓', 1600);
              updatePill();
            }
          },
          onStatus: function () {
            updatePill();
          },
          onError: function (err) {
            toast('AI 识屏未开启: ' + (err.message || '用户取消授权'), 3500);
            updatePill();
          }
        });
        toast('AI 识屏已开启! 自动提取微软下方「第N张幻灯片」，毫秒随动 ✓', 3800);
        updatePill();
      } catch (e) {
        updatePill();
      }
    }

    function syncCurrentPage() {
      toast('当前板书页: 第 ' + S.page + ' 页 · 笔迹已保存对齐 ✓', 2000);
      var syncBtn = syncPill.querySelector('[data-sp=sync]');
      if (syncBtn) {
        syncBtn.classList.add('synced');
        syncBtn.textContent = '已同步 ✓';
        setTimeout(function () {
          syncBtn.classList.remove('synced');
          syncBtn.textContent = '同步';
        }, 2000);
      }
    }

    syncPill.onclick = function (e) {
      var b = e.target.closest('[data-sp]');
      if (!b) return;
      var sp = b.getAttribute('data-sp');
      if (sp === 'prev') {
        triggerPrev();
      } else if (sp === 'next') {
        triggerNext();
      } else if (sp === 'ocr') {
        toggleOcrSync();
      } else if (sp === 'sync') {
        syncCurrentPage();
      }
      updatePill();
    };

    /* ==================================================================
     *  微软 PostMessage 通信与自动跟随
     * ================================================================== */
    function onMsMessage(e) {
      if (S.dead || !e || !e.data) return;
      var msg = e.data;
      if (typeof msg === 'string') {
        try { msg = JSON.parse(msg); } catch (err) { }
      }
      if (!msg) return;

      // 微软 Office Online 握手协议 (通过 &sftc=1 激活)
      if (msg.MessageId === 'App_IsFrameTrusted') {
        var f = curFrame();
        if (f && f.contentWindow) {
          try {
            f.contentWindow.postMessage(JSON.stringify({
              MessageId: 'Host_IsFrameTrusted',
              SendTime: Date.now(),
              Values: { isTopFrameTrusted: true }
            }), '*');
            f.contentWindow.postMessage(JSON.stringify({
              MessageId: 'Host_PostmessageReady',
              SendTime: Date.now(),
              Values: {}
            }), '*');
          } catch (err2) { }
        }
        return;
      }

      // 检测页码更新广播
      var p = null;
      if (typeof msg.page === 'number') p = msg.page;
      else if (typeof msg.slide === 'number') p = msg.slide;
      else if (typeof msg.slideIndex === 'number') p = msg.slideIndex + 1;
      else if (msg.Values) {
        if (typeof msg.Values.page === 'number') p = msg.Values.page;
        else if (typeof msg.Values.slide === 'number') p = msg.Values.slide;
        else if (typeof msg.Values.slideIndex === 'number') p = msg.Values.slideIndex + 1;
      }
      if (p && p >= 1 && p <= total() && p !== S.page) {
        console.log('[MSStage] 收到微软页面变更通知:', p);
        goPage(p);
      }
    }
    window.addEventListener('message', onMsMessage, false);

    /* ==================================================================
     *  键盘
     * ================================================================== */
    function onKey(e) {
      if (S.dead) return;
      if (textIn) return;
      var tg = e.target;
      if (tg && /INPUT|TEXTAREA|SELECT/.test(tg.tagName)) return;
      var k = (e.key || '').toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); undo(); return; }
      if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
      if ((e.ctrlKey || e.metaKey) && (k === 'arrowleft' || k === 'pageup' || k === 'arrowup')) { e.preventDefault(); triggerPrev(); return; }
      if ((e.ctrlKey || e.metaKey) && (k === 'arrowright' || k === 'pagedown' || k === 'arrowdown')) { e.preventDefault(); triggerNext(); return; }
      if (e.key === 'Tab') { e.preventDefault(); syncCurrentPage(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      var isNext = (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ' || e.key === 'ArrowDown' ||
                    e.key === 'Right' || e.key === 'Down' || e.key === 'Next' || e.code === 'PageDown' || e.code === 'ArrowDown' ||
                    e.keyCode === 34 || e.keyCode === 40 || e.keyCode === 39 || e.keyCode === 32 || e.keyCode === 13);
      var isPrev = (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'ArrowUp' ||
                    e.key === 'Left' || e.key === 'Up' || e.key === 'Prior' || e.code === 'PageUp' || e.code === 'ArrowUp' ||
                    e.keyCode === 33 || e.keyCode === 38 || e.keyCode === 37);

      if (isNext) {
        e.preventDefault();
        triggerNext();
        return;
      }
      if (isPrev) {
        e.preventDefault();
        triggerPrev();
        return;
      }
      else if (e.key === 'Home') { e.preventDefault(); goPage(1); }
      else if (e.key === 'End') { e.preventDefault(); goPage(total()); }
      else if (e.key === 'Escape') {
        if (!blk.classList.contains('hidden')) blk.classList.add('hidden');
        else if (S.align) exitAlign();
        else if (!pop.classList.contains('hidden')) pop.classList.add('hidden');
        else if (S.tool !== 'cursor') setTool('cursor');
        else if (S.mode === 'view') doExit();
      } else if (KEY_TOOL[k]) setTool(S.tool === KEY_TOOL[k] ? 'cursor' : KEY_TOOL[k]);
      else if (k === 'p' || k === 'l') setTool(S.tool === 'laser' ? 'cursor' : 'laser');
      else if (k === 'e') setTool('eraser');
      else if (k === 'b') blk.classList.toggle('hidden');
      else if (k === 'f') toggleFull();
      else if (k === 'g') toggleFilm();
      else if (k === '+' || k === '=') addPage();
      else if (/^[0-9]$/.test(k)) {
        var n = +k; if (n === 0) n = 10;
        if (n <= total()) goPage(n);
      }
      else if (k === 'delete' || k === 'backspace') {
        if (S.selId) {
          var arr = S.strokes[pid()] || [];
          for (var i = 0; i < arr.length; i++) {
            if (arr[i].id === S.selId) { opPush(pid(), { op: 'del', s: arr.splice(i, 1)[0] }); S.selId = null; redraw(); break; }
          }
        }
      }
    }
    window.addEventListener('keydown', onKey, true);

    /* ==================================================================
     *  保存 / 读取
     * ================================================================== */
    function pagesOut() {
      var out = [], i;
      for (i = 0; i < S.slides; i++) out.push({ t: 'ms', n: i, pid: 'm' + i, bg: 'w' });
      for (i = 0; i < S.extra; i++) out.push({ t: 'blank', pid: 'x' + i, w: VW, h: VH, bg: S.cfg.boardBg });
      return out;
    }
    function serialize() {
      return {
        pages: pagesOut(), strokes: S.strokes, bb: { n: S.bbN },
        ms: { rect: S.rect || null, sync: S.sync, extra: S.extra, v: 2 }
      };
    }
    function saveSoon() {
      S.dirty = true;
      clearTimeout(S.saveT);
      S.saveT = setTimeout(saveNow, 800);
    }
    function saveNow() {
      if (!S.dirty) return Promise.resolve();
      S.dirty = false;
      return fetch('/api/files/' + S.fid + '/annotations', {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.token },
        body: JSON.stringify(serialize())
      }).then(function (r) { if (!r.ok) S.dirty = true; }).catch(function () { S.dirty = true; });
    }
    function flushSave() {
      if (!S.dirty) return;
      try {
        fetch('/api/files/' + S.fid + '/annotations', {
          method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.token },
          body: JSON.stringify(serialize()), keepalive: true
        });
        S.dirty = false;
      } catch (e) { }
    }
    window.addEventListener('beforeunload', flushSave);
    S._autoSave = setInterval(function () { if (S.dead) return; if (S.dirty) saveNow(); }, 15000);

    /* ==================================================================
     *  启动
     * ================================================================== */
    function boot() {
      document.title = (S.meta.name || '课件') + (S.mode === 'present' ? ' - FLA 放映' : ' - FLA');
      var t = wrap.querySelector('#msTitle');
      if (t) t.textContent = S.meta.name || '课件';
      return Promise.all([
        jget('/api/files/' + S.fid + '/ms-view'),
        jget('/api/files/' + S.fid + '/annotations').catch(function () { return null; }),
        jget('/api/files/' + S.fid + '/anim').catch(function () { return null; })
      ]).then(function (rs) {
        S.mv = rs[0]; S.ann = rs[1]; S.manifest = rs[2];
        if (!S.mv || !S.mv.direct) throw new Error('无法取得微软在线视图直链');
        S.slides = Math.max(1, S.mv.pages || 1);
        S.strokes = (S.ann && S.ann.strokes) || {};
        if (S.ann && S.ann.bb && S.ann.bb.n) S.bbN = S.ann.bb.n;
        var ms = (S.ann && S.ann.ms) || null;
        if (ms) {
          if (ms.extra) S.extra = ms.extra | 0;
          if (ms.rect && ms.rect.length === 4) S.rect = ms.rect;
          if (ms.sync && ms.sync !== S.sync) { S.sync = ms.sync; }
        } else if (S.ann && S.ann.pages && S.ann.pages.length > S.slides) {
          /* 旧版数据: 多出来的页当板书页 */
          S.extra = S.ann.pages.length - S.slides;
        }
        /* 页数校正: 直接上传的 PPT 有时 pages 为 0 */
        if (S.mv.slide_ids && S.mv.slide_ids.length && S.slides !== S.mv.slide_ids.length) {
          S.slides = S.mv.slide_ids.length;
        }

        if (!S.mv.ms_ok) {
          toast('微软要求"域名 + 80/443"的公开直链, 当前是 ' + S.mv.direct +
                ' — 请在服务器执行 sudo bash https.sh 域名 (自动文件验证签发证书)', 12000);
        }

        /* iframe 数量: 放映 2 个(乒乓 + 预载), 浏览 1 个(省内存) */
        var nf = S.mode === 'present' ? 2 : 1;
        try { nf = clamp(parseInt(/[?&]frames=(\d)/.exec(location.search)[1], 10) || nf, 1, 3); } catch (e) { }
        for (var i = 0; i < nf; i++) S.frames.push(mkFrame());

        sizeCanvas();
        updatePageUI();
        setTool(st('fla_ms_tool', 'cursor'));
        setSync(S.sync, true);
        goPage(1, true);
        if (S.mode === 'present') {
          setTimeout(function () {
            toast('翻页: ← → / 缩略图(G) — 板书会跟着切页 · 拿笔: 左侧工具条或按 2', 7000);
          }, 1200);
        }
        if (S.slides > 1 && S.sync === 'deep' && st('fla_ms_done_check', '') !== '1') {
          setTimeout(function () { if (!S.dead) hintCheck(); }, 9000);
        }
        return stage;
      });
    }

    S._onResize = function () { if (!S.dead) { sizeCanvas(); if (S.align) paintAlign(); } };
    S._onVV = function () { if (!S.dead) sizeCanvas(); };
    window.addEventListener('resize', S._onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S._onVV);

    var stage = {
      S: S, el: wrap, toast: toast, goPage: goPage, setTool: setTool,
      setSync: setSync, selfTest: selfTest, save: saveNow, toggleFilm: toggleFilm,
      destroy: function () {
        if (S.dead) return;
        S.dead = true;
        flushSave();
        if (window.FLA_OCR) {
          try { window.FLA_OCR.stopCapture(); } catch (e) { }
        }
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('message', onMsMessage, false);
        /* 摘掉全部窗口级监听与定时器: 反复进出放映不累积泄漏 */
        window.removeEventListener('beforeunload', flushSave);
        if (S._onResize) window.removeEventListener('resize', S._onResize);
        if (S._onVV && window.visualViewport) window.visualViewport.removeEventListener('resize', S._onVV);
        if (S._autoSave) { clearInterval(S._autoSave); S._autoSave = 0; }
        if (S._clock) { clearInterval(S._clock); S._clock = 0; }
        clearTimeout(S.saveT); clearTimeout(S.hideT);
        if (textIn) { try { textIn.ta.remove(); } catch (e) { } textIn = null; }
        try { wrap.remove(); } catch (e) { }
      }
    };
    return boot();
  }

  window.MSStage = { mount: mount, icon: icon };
})();
