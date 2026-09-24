/* FLA - 前端主应用: 现代化桌面端工作台 / 课件库 / 桌面客户端中心 / 论坛 / 个人中心 */
'use strict';
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const toast = (m, t) => UI.toast(m, t);
window.toast = toast;

window.App = {
  user: null,
  files: [],
  filteredFiles: [],
  selectedFids: new Set(),
  searchTerm: '',
  filterKind: 'all',
  sortBy: 'date_desc',
  viewMode: (function() {
    try { return localStorage.getItem('fla_view_mode') || 'grid'; } catch(e) { return 'grid'; }
  })(),
  desktopReady: false,
  inspectingFile: null,
  setCleanup(fn) { App._cleanup = fn; }
};

let _cleanup = null;
let pollT = null;
let desktopProbeTimer = null;

const ACCEPT = '.ppt,.pptx,.pps,.ppsx,.pot,.potx,.doc,.docx,.dot,.dotx,.rtf,.xls,.xlsx,.csv,.txt,.odt,.ods,.odp,.wps,.et,.dps,.pdf,.png,.jpg,.jpeg,.webp,.gif,.bmp,.svg,.mp3,.wav,.ogg,.m4a,.aac,.flac,.mp4,.webm,.mkv,.mov,.m4v';

/* ================================================================
 *  1. 客户端与本地 8307 桥接探测 (桌面端实时联通状态)
 * ================================================================ */
async function probeDesktopClient() {
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 1200);
    const r = await fetch('http://127.0.0.1:8307/api/status', { signal: ctrl.signal }).catch(() => null);
    clearTimeout(tid);
    if (r && r.ok) {
      App.desktopReady = true;
      updateDesktopStatusUI();
      return true;
    }
  } catch (e) {}
  App.desktopReady = false;
  updateDesktopStatusUI();
  return false;
}

function updateDesktopStatusUI() {
  const pill = $('#top-desktop-status');
  if (pill) {
    if (App.desktopReady) {
      pill.innerHTML = '<span class="dh-dot online" style="display:inline-block;margin-right:5px;"></span>客户端已就绪';
      pill.className = 'btn sm soft';
      pill.title = 'FLA 桌面助手正在运行 (127.0.0.1:8307 桥接已连接)';
    } else {
      pill.innerHTML = UI.icon('laptop', 14) + ' <span>桌面端</span>';
      pill.className = 'btn sm ghost';
      pill.title = '未检测到本地桌面客户端 (点击进入桌面端中心)';
    }
  }
}

/* ================================================================
 *  2. 应用初始化与全局路由
 * ================================================================ */
async function initApp() {
  window.addEventListener('hashchange', route);
  if (API.token) {
    try {
      App.user = await API.get('/api/auth/me');
    } catch (e) {
      API.setToken('');
      App.user = null;
    }
  }
  if (window.Chat && App.user) Chat.startBadge();
  
  // 顶栏滚动收紧
  let stickRaf = 0;
  const onScroll = () => {
    if (stickRaf) return;
    stickRaf = requestAnimationFrame(() => {
      stickRaf = 0;
      const t = document.querySelector('.topbar');
      if (!t) return;
      const want = (window.scrollY || document.documentElement.scrollTop || 0) > 6;
      if (t.classList.contains('stuck') !== want) t.classList.toggle('stuck', want);
    });
  };
  window.addEventListener('scroll', onScroll, { passive: true });

  // 全局快捷键与拖拽
  setupGlobalShortcuts();
  setupGlobalDragDrop();

  // 桌面端状态后台探测 (仅在已登录真实浏览器中按需探测)
  if (typeof navigator !== 'undefined' && navigator.userAgent !== 'Node' && App.user) {
    probeDesktopClient();
    if (desktopProbeTimer) clearInterval(desktopProbeTimer);
    desktopProbeTimer = setInterval(probeDesktopClient, 12000);
  }

  route();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

function runCleanup() {
  if (_cleanup) { try { _cleanup(); } catch (e) { } _cleanup = null; }
  if (pollT) { clearInterval(pollT); pollT = null; }
}
App.runCleanup = runCleanup;

function route() {
  runCleanup();
  const rawHash = location.hash || '';
  const path = rawHash.replace(/^#\/?/, '').split('?')[0];
  const parts = path.split('/').filter(Boolean);
  
  if (parts[0] === 'remote') {
    if (window.Remote) return window.Remote.view();
  }
  if (!App.user) {
    if (parts[0] === 'login') return viewLogin();
    if (parts[0] === 'register') return viewRegister();
    if (parts[0] === 'qr-approve') {
      try { sessionStorage.setItem('fla_after_login', location.hash); } catch (e) { }
      return viewLogin();
    }
    return viewHome();
  }
  if (parts[0] === 'login' || parts[0] === 'register') { location.hash = '#/library'; return; }
  if (parts[0] === 'home') return viewHome();
  refreshAnnBadge();
  if (window.Chat) Chat.refreshBadge();

  if (!parts.length || parts[0] === 'library') return viewLibrary();
  if (parts[0] === 'desktop') return viewDesktopCenter();
  if (parts[0] === 'profile') return viewProfile();
  if (parts[0] === 'forum') return viewForum(parts[1] ? parseInt(parts[1], 10) : 0);
  if (parts[0] === 'chat') return Chat.view();
  if (parts[0] === 'qr-approve') return viewQrApprove();
  if (parts[0] === 'admin') {
    if (App.user.role !== 'admin') { toast('需要管理员权限', 'err'); location.hash = '#/library'; return; }
    return Admin.view();
  }
  if (parts[0] === 'view' && parts[1] && window.Viewer) { Viewer.open(parseInt(parts[1], 10)); refreshAnnBadge(); return; }
  location.hash = '#/library';
}

/* ================================================================
 *  3. 全局快捷键与全屏拖拽上传
 * ================================================================ */
function setupGlobalShortcuts() {
  document.addEventListener('keydown', e => {
    // ⌘K 或 Ctrl+K 触发搜索或桌面命令
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      const sInp = $('#lib-search-input');
      if (sInp) { sInp.focus(); sInp.select(); }
      else { location.hash = '#/library'; setTimeout(() => { const i = $('#lib-search-input'); if (i) i.focus(); }, 150); }
      return;
    }
    // / 键直接聚焦课件搜索
    if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
      const sInp = $('#lib-search-input');
      if (sInp) { e.preventDefault(); sInp.focus(); }
      return;
    }
    // Esc 键关闭抽屉或取消选择
    if (e.key === 'Escape') {
      closeFileDrawer();
      if (App.selectedFids.size > 0) {
        App.selectedFids.clear();
        updateBatchBar();
        renderFileList();
      }
    }
  });
}

function setupGlobalDragDrop() {
  let dragCounter = 0;
  window.addEventListener('dragenter', () => {
    if (['#/library', '#/home'].includes(location.hash || '#/library')) {
      dragCounter++;
      showGlobalDropzone(true);
    }
  });
  window.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      showGlobalDropzone(false);
    }
  });
  window.addEventListener('dragover', e => { e.preventDefault(); });
  window.addEventListener('drop', e => {
    e.preventDefault();
    dragCounter = 0;
    showGlobalDropzone(false);
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      if (!App.user) {
        toast('请先登录后再上传课件', 'warn');
        return;
      }
      if (location.hash !== '#/library') location.hash = '#/library';
      uploadFiles(Array.from(e.dataTransfer.files));
    }
  });
}

function showGlobalDropzone(show) {
  let el = $('#global-drop-overlay');
  if (!el && show) {
    el = document.createElement('div');
    el.id = 'global-drop-overlay';
    el.className = 'global-drop-backdrop';
    el.innerHTML = '<div class="global-drop-box">' +
      UI.icon('upload', 52) +
      '<h3>释放鼠标以上传课件到 FLA 云端</h3>' +
      '<p>支持 PPT / Word / Excel / PDF / 视频 / 音频 / 图片</p>' +
      '</div>';
    document.body.appendChild(el);
  }
  if (el) el.classList.toggle('active', show);
}

/* ================================================================
 *  4. 通用辅助与认证徽章体系 (兼容测试脚本)
 * ================================================================ */
function avatarHTML(u, size) {
  size = size || 34;
  const st = 'width:' + size + 'px;height:' + size + 'px';
  if (u && u.avatar) return '<img class="avatar" style="' + st + '" src="' + UI.esc(u.avatar) + '">';
  const c = UI.esc(((u && u.nickname) || 'U').slice(0, 1).toUpperCase());
  return '<span class="avatar avatar-ph" style="' + st + ';font-size:' + Math.round(size * .45) + 'px">' + c + '</span>';
}

function certHTML(u) {
  if (!u) return '';
  let h = '';
  if (u.role === 'admin') h += '<span class="cert owner" title="站长认证">' + UI.icon('crown', 13) + '<em>站长</em></span>';
  if (u.is_teacher) {
    const icon = CERT_ICON_LIST.includes(u.cert_icon) ? u.cert_icon : 'medal';
    const color = /^#[0-9a-fA-F]{6}$/.test(u.cert_color || '') ? u.cert_color : '';
    h += '<span class="cert"' + (color ? ' style="--cc:' + color + '"' : '') + ' title="教师认证">' +
      UI.icon(icon, 13) + '<em>' + UI.esc(u.cert_title || '认证教师') + '</em></span>';
  }
  return h;
}

const CERT_ICON_LIST = ['medal', 'star', 'crown', 'award', 'shield', 'heart', 'zap', 'gem', 'trophy', 'flag'];
const CERT_COLOR_LIST = ['#f0d488', '#d8dee9', '#e8b48f', '#93c5fd', '#d8b4fe', '#fca5a5', '#86efac', '#fdba74'];

function hexA(hex, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return 'rgba(240,212,136,' + a + ')';
  const n = parseInt(m[1], 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

function certCode(u) {
  const raw = 'FLA|' + (u.id || 0) + '|' + (u.role || '') + '|' + (u.is_teacher ? 1 : 0) + '|' +
    (u.cert_title || '') + '|' + String(u.created_at || '').slice(0, 10);
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) { h ^= raw.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  const s36 = (h.toString(36).toUpperCase() + '000000').slice(0, 6);
  return s36.slice(0, 3) + '-' + s36.slice(3);
}

function certTier(u) {
  if (u.role === 'admin') return { k: 'platinum', zh: '铂金', en: 'PLATINUM AURORA' };
  const c = (u.cert_color || '#f0d488').toLowerCase();
  const m = /^#([0-9a-f]{6})$/.exec(c);
  if (!m) return { k: 'custom', zh: '定制', en: 'CUSTOM EDITION' };
  const n = parseInt(m[1], 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 510, sat = mx ? (mx - mn) / mx : 0;
  if (sat < .16) return l > .62 ? { k: 'silver', zh: '白银', en: 'SILVER EDITION' } : { k: 'graphite', zh: '墨金', en: 'GRAPHITE EDITION' };
  if (r > g && g > b) return l > .58 ? { k: 'gold', zh: '黄金', en: 'GOLD EDITION' } : { k: 'bronze', zh: '青铜', en: 'BRONZE EDITION' };
  if (b > r) return { k: 'sapphire', zh: '蓝宝', en: 'SAPPHIRE EDITION' };
  if (g > r) return { k: 'emerald', zh: '翡翠', en: 'EMERALD EDITION' };
  return { k: 'custom', zh: '定制', en: 'CUSTOM EDITION' };
}

function certCardHTML(u) {
  const no = 'FLA-' + ('0000' + (u.id || 0)).slice(-4);
  const code = certCode(u);
  const tier = certTier(u);
  const since = String(u.created_at || '').slice(0, 10) || '—';
  const spark = (l, t, d, sz) => '<i class="cc-spark" style="left:' + l + '%;top:' + t + '%;animation-delay:' + d + 's;font-size:' + sz + 'px">✦</i>';
  const sparks = spark(9, 18, 0, 13) + spark(88, 13, 1.1, 10) + spark(80, 62, 2.2, 14) + spark(13, 68, .6, 10);
  let h = '';

  if (u.role === 'admin') {
    h += '<div class="cert-card tier-platinum" data-cert="owner" data-no="' + no + '" data-code="' + code + '"' +
      ' data-title="站长" data-en="FLA · SITE OWNER" data-since="' + since + '" data-tier="' + tier.en + '">' +
      '<i class="cc-guilloche"></i><i class="cc-beam"></i><i class="cc-holo"></i>' + sparks +
      '<div class="cc-inner">' +
      '<div class="cc-tier">' + UI.icon('gem', 12) + '<span>' + tier.en + ' · ' + tier.zh + '级</span></div>' +
      '<div class="cc-medal">' + UI.icon('crown', 46) + '</div>' +
      '<div class="cc-title">站长</div>' +
      '<div class="cc-sub">FLA · SITE OWNER</div>' +
      '<div class="cc-rows">' +
      '<div><span>证书编号</span><b>NO. ' + no + '</b></div>' +
      '<div><span>签发日期</span><b>' + since + '</b></div>' +
      '<div><span>授权范围</span><b>站点创始人 · 最高权限</b></div>' +
      '<div><span>校验码</span><b>' + code + '</b></div>' +
      '</div>' +
      '<div class="cc-foot"><div class="cc-qr"></div>' +
      '<div class="cc-sign"><b>FLA 官方签发</b><em>扫码核验 · ' + code + '</em></div>' +
      '<div class="cc-seal"><b>FLA</b><span>站长</span></div></div>' +
      '</div>' +
      '<div class="cc-acts"><button type="button" data-ca="zoom">' + UI.icon('maximize', 13) + ' 查看大图</button>' +
      '<button type="button" data-ca="print">' + UI.icon('download', 13) + ' 打印 / 存 PDF</button></div>' +
      '</div>';
  } else if (u.is_teacher) {
    const icon = CERT_ICON_LIST.includes(u.cert_icon) ? u.cert_icon : 'medal';
    const color = /^#[0-9a-fA-F]{6}$/.test(u.cert_color || '') ? u.cert_color : '#f0d488';
    const title = u.cert_title || '认证教师';
    h += '<div class="cert-card tier-' + tier.k + '" data-cert="teacher" data-no="' + no + '" data-code="' + code + '"' +
      ' data-title="' + UI.esc(title) + '" data-en="FLA · CERTIFIED EDUCATOR" data-since="' + since + '"' +
      ' data-tier="' + tier.en + '" style="--cc:' + color + '">' +
      '<i class="cc-guilloche"></i><i class="cc-holo"></i>' + sparks +
      '<div class="cc-inner">' +
      '<div class="cc-tier">' + UI.icon('medal', 12) + '<span>' + tier.en + ' · ' + tier.zh + '级</span></div>' +
      '<div class="cc-medal">' + UI.icon(icon, 48) + '</div>' +
      '<div class="cc-title">' + UI.esc(title) + '</div>' +
      '<div class="cc-sub">FLA · CERTIFIED EDUCATOR</div>' +
      '<div class="cc-rows">' +
      '<div><span>证书编号</span><b>NO. ' + no + '</b></div>' +
      '<div><span>签发日期</span><b>' + since + '</b></div>' +
      '<div><span>持证人</span><b>' + UI.esc(u.nickname || u.username || '') + '</b></div>' +
      '<div><span>校验码</span><b>' + code + '</b></div>' +
      '</div>' +
      '<div class="cc-foot"><div class="cc-qr"></div>' +
      '<div class="cc-sign"><b>FLA 官方认证</b><em>扫码核验 · ' + code + '</em></div>' +
      '<div class="cc-seal"><b>FLA</b><span>已认证</span></div></div>' +
      '</div>' +
      '<div class="cc-acts"><button type="button" data-ca="zoom">' + UI.icon('maximize', 13) + ' 查看大图</button>' +
      '<button type="button" data-ca="print">' + UI.icon('download', 13) + ' 打印 / 存 PDF</button></div>' +
      '</div>';
  } else {
    h += '<div class="cert-card pending">' +
      '<div class="cc-medal">' + UI.icon('lock', 28) + '</div>' +
      '<div class="cc-title">教师认证</div>' +
      '<div class="cc-sub">FLA · CERTIFIED EDUCATOR</div>' +
      '<p class="cc-note">未完成教师认证（不影响课件功能，认证后展示专属证书）</p>' +
      '</div>';
  }
  return h;
}

function bindCertCards(root) {
  const cards = $$('.cert-card:not(.pending)', root || document);
  cards.forEach(card => {
    let raf = 0;
    const move = e => {
      const r = card.getBoundingClientRect();
      const px = (e.clientX - r.left) / (r.width || 1), py = (e.clientY - r.top) / (r.height || 1);
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        card.style.setProperty('--rx', ((0.5 - py) * 11).toFixed(2) + 'deg');
        card.style.setProperty('--ry', ((px - 0.5) * 14).toFixed(2) + 'deg');
        card.style.setProperty('--mx', (px * 100).toFixed(1) + '%');
        card.style.setProperty('--my', (py * 100).toFixed(1) + '%');
      });
    };
    card.addEventListener('pointermove', move);
    card.addEventListener('pointerleave', () => {
      card.style.setProperty('--rx', '0deg'); card.style.setProperty('--ry', '0deg');
      card.style.setProperty('--mx', '50%'); card.style.setProperty('--my', '50%');
    });
    const qr = $('.cc-qr', card);
    if (qr && !qr.dataset.done) {
      qr.dataset.done = '1';
      const txt = 'FLA CERTIFICATE\nNO. ' + card.dataset.no + '\n' + card.dataset.title + '\n' + card.dataset.code;
      if (UI && UI.renderQR) UI.renderQR(qr, txt, 62);
    }
    $$('.cc-acts button', card).forEach(b => b.onclick = ev => {
      ev.preventDefault(); ev.stopPropagation();
      const act = b.dataset.ca;
      if (act === 'zoom') certZoom(card);
      else if (act === 'print') certPrint(card);
    });
  });
}

function certZoom(card) {
  const ov = document.createElement('div');
  ov.className = 'cc-zoom';
  const clone = card.cloneNode(true);
  clone.classList.add('cc-big');
  clone.querySelectorAll('.cc-acts').forEach(x => x.remove());
  ov.innerHTML = '<button class="cc-zoom-x" type="button">' + UI.icon('close', 20) + '</button>';
  ov.appendChild(clone);
  document.body.appendChild(ov);
  requestAnimationFrame(() => ov.classList.add('on'));
  bindCertCards(ov);
  const close = () => { ov.classList.remove('on'); setTimeout(() => ov.remove(), 280); };
  ov.addEventListener('click', e => { if (e.target === ov || e.target.closest('.cc-zoom-x')) close(); });
  const onKey = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
}

function certPrint(card) {
  const ov = document.createElement('div');
  ov.className = 'cc-print';
  const clone = card.cloneNode(true);
  clone.querySelectorAll('.cc-acts').forEach(x => x.remove());
  ov.appendChild(clone);
  document.body.appendChild(ov);
  bindCertCards(ov);
  const done = () => { setTimeout(() => ov.remove(), 400); };
  window.addEventListener('afterprint', done, { once: true });
  setTimeout(() => { window.print(); setTimeout(done, 1500); }, 260);
}
window.certCardHTML = certCardHTML;
window.bindCertCards = bindCertCards;

function bindLogout() {
  const b = $('#logout');
  if (b) b.onclick = () => { API.setToken(''); App.user = null; location.hash = '#/home'; };
}
window.bindLogout = bindLogout;

/* ================================================================
 *  5. App Shell: 现代化桌面级导航顶栏
 * ================================================================ */
function shell(content, active) {
  const u = App.user;
  const deskStatus = App.desktopReady
    ? '<a class="btn sm soft" id="top-desktop-status" href="#/desktop" title="桌面端已连接 (8307)"><span class="dh-dot online" style="display:inline-block;margin-right:5px;"></span>客户端就绪</a>'
    : '<a class="btn sm ghost" id="top-desktop-status" href="#/desktop" title="下载/连接桌面端">' + UI.icon('laptop', 14) + ' <span>桌面端</span></a>';

  return '<header class="topbar">' +
    '<div style="display:flex;align-items:center;gap:18px;">' +
      '<a class="brand" href="#/home" title="返回官网首页">' +
        UI.icon('board', 24) + '<span>FLA</span><span class="brand-pill">v1.36</span>' +
      '</a>' +
      '<nav class="nav">' +
        '<a class="' + (active === 'library' ? 'on' : '') + '" href="#/library">' + UI.icon('folder', 15) + ' 课件库</a>' +
        '<a class="' + (active === 'desktop' ? 'on' : '') + '" href="#/desktop">' + UI.icon('laptop', 15) + ' 桌面端中心</a>' +
        '<a class="' + (active === 'chat' ? 'on' : '') + '" href="#/chat">' + UI.icon('chat', 15) +
          ' 聊天<i class="nav-badge hidden" id="chat-badge"></i></a>' +
        '<a class="' + (active === 'forum' ? 'on' : '') + '" href="#/forum">' + UI.icon('forum', 15) + ' 论坛</a>' +
        '<a class="' + (active === 'profile' ? 'on' : '') + '" href="#/profile">' + UI.icon('users', 15) + ' 个人中心</a>' +
        (u.role === 'admin' ? '<a class="' + (active === 'admin' ? 'on' : '') + '" href="#/admin">' + UI.icon('gear', 15) + ' 管理后台</a>' : '') +
      '</nav>' +
    '</div>' +
    '<div class="top-right">' +
      deskStatus +
      '<a class="btn sm ghost" href="#/remote" title="手机扫码遥控与投屏">' + UI.icon('qr', 14) + ' 手机遥控</a>' +
      '<button class="icon-btn" id="top-ann" title="公告"><i class="ann-dot hidden" id="ann-dot"></i>' + UI.icon('horn', 16) + '</button>' +
      '<button class="icon-btn" id="top-qr" title="扫码登录其他设备">' + UI.icon('qr', 16) + '</button>' +
      certHTML(u) +
      '<span class="uchip">' + avatarHTML(u, 26) + '<b>' + UI.esc(u.nickname) + '</b></span>' +
      '<button class="btn sm ghost" id="logout" title="退出登录">' + UI.icon('logout', 15) + '</button>' +
    '</div>' +
    '</header>' +
    '<div class="page">' + content + '</div>';
}

/* ================================================================
 *  6. 课件库工作台 (搜索/分类/排序/双视图/批量管理/侧边抽屉)
 * ================================================================ */
async function viewLibrary() {
  document.title = '我的课件 - FLA';
  $('#app').innerHTML = shell(
    '<div class="lib-hero">' +
      '<div class="lib-hero-left">' +
        '<h2>我的课件</h2>' +
        '<p>现代化教学资源管理 · 一键多端联动放映 · 原生Office高速预览</p>' +
      '</div>' +
      '<div class="lib-hero-actions">' +
        '<div class="storage-card" id="storage"></div>' +
        '<button class="btn" id="newboard">' + UI.icon('edit', 16) + ' 新建白板</button>' +
        '<button class="btn primary" id="upbtn">' + UI.icon('upload', 18) + ' 上传课件</button>' +
        '<input type="file" id="upinput" multiple hidden accept="' + ACCEPT + '">' +
      '</div>' +
    '</div>' +

    '<div class="lib-toolbar">' +
      '<div class="lib-search-box">' +
        '<span class="lib-search-icon">' + UI.icon('search', 16) + '</span>' +
        '<input type="search" id="lib-search-input" placeholder="搜索课件名称… (按 / 聚焦)" value="' + UI.esc(App.searchTerm) + '">' +
        (App.searchTerm ? '<button class="lib-search-clear" id="lib-search-clear">×</button>' : '') +
      '</div>' +

      '<div class="lib-filters">' +
        renderFilterPills() +
      '</div>' +

      '<div class="lib-view-ops">' +
        '<select class="lib-sort-select" id="lib-sort-select">' +
          '<option value="date_desc"' + (App.sortBy === 'date_desc' ? ' selected' : '') + '>最新上传优先</option>' +
          '<option value="date_asc"' + (App.sortBy === 'date_asc' ? ' selected' : '') + '>最早上传优先</option>' +
          '<option value="name_asc"' + (App.sortBy === 'name_asc' ? ' selected' : '') + '>文件名称 A-Z</option>' +
          '<option value="size_desc"' + (App.sortBy === 'size_desc' ? ' selected' : '') + '>文件体积最大</option>' +
        '</select>' +

        '<div class="view-toggle">' +
          '<button class="view-toggle-btn ' + (App.viewMode === 'grid' ? 'active' : '') + '" id="vt-grid" title="卡片网格视图">' + UI.icon('grid', 15) + '</button>' +
          '<button class="view-toggle-btn ' + (App.viewMode === 'table' ? 'active' : '') + '" id="vt-table" title="详细列表视图">' + UI.icon('list', 15) + '</button>' +
        '</div>' +
      '</div>' +
    '</div>' +

    '<div class="dropzone" id="dropzone">' + UI.icon('cloud', 18) + ' 或将文件拖到这里 · 支持 Office / PDF / 图片 / 音频 / 视频</div>' +

    '<div id="files-container">' +
      '<div class="files-grid" id="grid"><div class="empty">加载中…</div></div>' +
    '</div>' +

    '<div class="batch-bar" id="batch-bar">' +
      '<span class="batch-count" id="batch-count">已选 0 项</span>' +
      '<button class="btn sm ghost" id="batch-dl-btn" style="color:#fff;">' + UI.icon('download', 14) + ' 批量下载</button>' +
      '<button class="btn sm danger" id="batch-del-btn">' + UI.icon('trash', 14) + ' 批量删除</button>' +
      '<button class="btn sm ghost" id="batch-cancel-btn" style="color:#a1a1aa;">取消选择</button>' +
    '</div>' +

    '<div class="file-drawer-backdrop" id="drawer-backdrop"></div>' +
    '<div class="file-drawer" id="file-drawer"></div>' +

    '<div class="uplist" id="uplist"></div>',
    'library'
  );

  bindLogout();
  refreshMe();
  bindLibraryToolbarEvents();
  await refreshList();

  $('#newboard').onclick = async () => {
    try {
      const f = await API.post('/api/files/board', {});
      location.hash = '#/view/' + f.id;
    } catch (e) { UI.toast(e.message, 'err'); }
  };
  $('#upbtn').onclick = () => $('#upinput').click();
  $('#upinput').onchange = e => { uploadFiles(Array.from(e.target.files)); e.target.value = ''; };

  const dz = $('#dropzone');
  if (dz) {
    dz.onclick = () => $('#upinput').click();
    dz.ondragover = e => { e.preventDefault(); dz.classList.add('over'); };
    dz.ondragleave = () => dz.classList.remove('over');
    dz.ondrop = e => { e.preventDefault(); dz.classList.remove('over'); uploadFiles(Array.from(e.dataTransfer.files)); };
  }
}

function renderFilterPills() {
  const kinds = [
    { id: 'all', label: '全部' },
    { id: 'ppt', label: '幻灯片 (PPT)' },
    { id: 'doc', label: '文档 (Word/PDF)' },
    { id: 'excel', label: '表格 (Excel)' },
    { id: 'board', label: '互动白板' },
    { id: 'media', label: '影音媒体' }
  ];
  return kinds.map(k =>
    '<button class="filter-pill ' + (App.filterKind === k.id ? 'active' : '') + '" data-k="' + k.id + '">' +
      k.label +
    '</button>'
  ).join('');
}

function bindLibraryToolbarEvents() {
  const sInp = $('#lib-search-input');
  if (sInp) {
    sInp.oninput = e => {
      App.searchTerm = e.target.value.trim().toLowerCase();
      applyFiltersAndSort();
    };
  }
  const sClr = $('#lib-search-clear');
  if (sClr) {
    sClr.onclick = () => {
      App.searchTerm = '';
      if (sInp) sInp.value = '';
      applyFiltersAndSort();
    };
  }
  $$('.filter-pill').forEach(btn => {
    btn.onclick = () => {
      App.filterKind = btn.dataset.k;
      $$('.filter-pill').forEach(b => b.classList.toggle('active', b === btn));
      applyFiltersAndSort();
    };
  });
  const sortSel = $('#lib-sort-select');
  if (sortSel) {
    sortSel.onchange = e => {
      App.sortBy = e.target.value;
      applyFiltersAndSort();
    };
  }
  const vtGrid = $('#vt-grid'), vtTable = $('#vt-table');
  if (vtGrid && vtTable) {
    vtGrid.onclick = () => setViewMode('grid');
    vtTable.onclick = () => setViewMode('table');
  }

  // 批量操作栏事件
  const bCancel = $('#batch-cancel-btn');
  if (bCancel) bCancel.onclick = () => { App.selectedFids.clear(); updateBatchBar(); renderFileList(); };
  const bDel = $('#batch-del-btn');
  if (bDel) bDel.onclick = batchDelete;
  const bDl = $('#batch-dl-btn');
  if (bDl) bDl.onclick = batchDownload;

  // 抽屉背景点击关闭
  const dbp = $('#drawer-backdrop');
  if (dbp) dbp.onclick = closeFileDrawer;
}

function setViewMode(mode) {
  App.viewMode = mode;
  try { localStorage.setItem('fla_view_mode', mode); } catch(e){}
  const vtGrid = $('#vt-grid'), vtTable = $('#vt-table');
  if (vtGrid) vtGrid.classList.toggle('active', mode === 'grid');
  if (vtTable) vtTable.classList.toggle('active', mode === 'table');
  renderFileList();
}

function applyFiltersAndSort() {
  let list = App.files.slice();

  // 1. 分类过滤
  if (App.filterKind !== 'all') {
    list = list.filter(f => {
      const ext = ((f.name || '').split('.').pop() || '').toLowerCase();
      if (App.filterKind === 'ppt') return /^(ppt|pptx|pps|ppsx|dps)$/.test(ext);
      if (App.filterKind === 'doc') return /^(doc|docx|wps|rtf|pdf|txt)$/.test(ext);
      if (App.filterKind === 'excel') return /^(xls|xlsx|et|csv)$/.test(ext);
      if (App.filterKind === 'board') return f.kind === 'board';
      if (App.filterKind === 'media') return /^(png|jpg|jpeg|webp|gif|svg|mp3|wav|mp4|webm|mkv|mov)$/.test(ext);
      return true;
    });
  }

  // 2. 搜索词
  if (App.searchTerm) {
    list = list.filter(f => (f.name || '').toLowerCase().includes(App.searchTerm));
  }

  // 3. 排序
  list.sort((a, b) => {
    if (App.sortBy === 'date_desc') return (b.created_at || '').localeCompare(a.created_at || '');
    if (App.sortBy === 'date_asc') return (a.created_at || '').localeCompare(b.created_at || '');
    if (App.sortBy === 'name_asc') return (a.name || '').localeCompare(b.name || '');
    if (App.sortBy === 'size_desc') return (b.size || 0) - (a.size || 0);
    return 0;
  });

  App.filteredFiles = list;
  renderFileList();
}

function renderFileList() {
  const container = $('#files-container');
  if (!container) return;

  const files = App.filteredFiles;
  if (!files.length) {
    container.innerHTML = '<div class="empty">' + UI.icon('file', 42) +
      '<p style="font-size:15px;margin-top:12px;">' +
      (App.searchTerm ? '未找到包含 “' + UI.esc(App.searchTerm) + '” 的课件' : '还没有课件，点击右上角「上传课件」开始') +
      '</p></div>';
    return;
  }

  if (App.viewMode === 'grid') {
    container.innerHTML = '<div class="files-grid" id="grid">' + files.map(cardHTML).join('') + '</div>';
    bindFileGridEvents();
  } else {
    container.innerHTML = renderTableViewHTML(files);
    bindFileTableEvents();
  }
}

function kindBadge(f) {
  const ext = ((f.name || '').split('.').pop() || '').toLowerCase();
  if (f.kind === 'board') return '<span class="kind-badge board">' + UI.icon('board', 12) + ' 白板</span>';
  if (/^(ppt|pptx|pps|ppsx|dps)$/.test(ext)) return '<span class="kind-badge ppt">' + UI.icon('play', 12) + ' PPT</span>';
  if (/^(doc|docx|wps|rtf)$/.test(ext)) return '<span class="kind-badge word">' + UI.icon('file', 12) + ' DOC</span>';
  if (/^(xls|xlsx|et|csv)$/.test(ext)) return '<span class="kind-badge excel">' + UI.icon('chart', 12) + ' XLS</span>';
  if (ext === 'pdf') return '<span class="kind-badge pdf">' + UI.icon('file', 12) + ' PDF</span>';
  if (/^(mp4|webm|mkv|mov|mp3|wav|png|jpg|jpeg|webp)$/.test(ext)) return '<span class="kind-badge media">' + UI.icon('image', 12) + ' 媒体</span>';
  return '<span class="kind-badge doc">' + UI.icon('file', 12) + ' 文件</span>';
}

function cardHTML(f) {
  const st = f.status === 'converting' ? '<span class="st converting">转换中…</span>'
    : f.status === 'failed' ? '<span class="st failed">转换失败</span>' : '';
  const isOffice = f.kind === 'office';
  const isSel = App.selectedFids.has(f.id);

  return '<div class="file-card ' + (isSel ? 'selected' : '') + '" data-id="' + f.id + '">' +
    '<div class="fc-select-box" data-sel="' + f.id + '" title="多选">' +
      (isSel ? '✓' : '') +
    '</div>' +
    '<div class="fc-top">' + kindBadge(f) + st + '</div>' +
    '<div class="fc-name" title="' + UI.esc(f.name) + '">' + UI.esc(f.name) + '</div>' +
    '<div class="fc-meta">' +
      (f.kind === 'board' ? '无限画布' : UI.fmtSize(f.size)) + ' · ' + UI.fmtDate(f.created_at) +
      (f.kind !== 'board' && f.pages ? ' · ' + f.pages + ' 页' : '') +
    '</div>' +
    '<div class="act">' +
    (isOffice
      ? '<button data-a="open" title="在线纯净预览">' + UI.icon('eye', 14) + ' 预览</button>' +
        '<button data-a="present" class="btn-present" title="全屏教学放映 (画笔/计时/抽选)">' + UI.icon('play', 13) + ' 放映</button>' +
        '<button data-a="local" class="btn-local" title="直接调用本地 PowerPoint/WPS">' + UI.icon('external', 13) + ' 本地打开</button>'
      : '<button data-a="open" title="打开">' + UI.icon('board', 15) + ' 打开</button>' +
        (f.kind !== 'board' ? '<button data-a="present" class="btn-present" title="全屏放映">' + UI.icon('play', 13) + ' 放映</button>' : '')) +
    (f.kind === 'board' ? '' : '<button data-a="dl" title="下载">' + UI.icon('download', 15) + '</button>') +
    (f.kind === 'board' ? '' : '<button data-a="link" title="复制公开直链">' + UI.icon('link', 15) + '</button>') +
    '<button data-a="rename" title="重命名">' + UI.icon('edit', 14) + '</button>' +
    '<button data-a="inspect" title="查看课件详情">' + UI.icon('info', 14) + '</button>' +
    (f.status === 'failed' ? '<button data-a="retry" title="重试转换">' + UI.icon('refresh', 15) + '</button>' : '') +
    '<button data-a="del" title="删除" class="danger">' + UI.icon('trash', 15) + '</button>' +
    '</div></div>';
}

function bindFileGridEvents() {
  const grid = $('#grid');
  if (!grid) return;
  $$('.file-card', grid).forEach(el => {
    const fid = +el.dataset.id;
    const f = App.files.find(x => x.id === fid);
    if (!f) return;

    // 单击卡片整体打开详情抽屉
    el.onclick = e => {
      if (e.target.closest('.fc-select-box') || e.target.closest('.act button')) return;
      openFileDrawer(f);
    };

    // 多选框点击
    const sBox = el.querySelector('.fc-select-box');
    if (sBox) {
      sBox.onclick = e => {
        e.stopPropagation();
        toggleSelectFile(fid);
      };
    }

    // 动作按钮
    $$('.act button', el).forEach(b => {
      b.onclick = e => {
        e.stopPropagation();
        handleFileAction(b.dataset.a, f);
      };
    });
  });
}

function renderTableViewHTML(files) {
  const allSel = files.length > 0 && files.every(f => App.selectedFids.has(f.id));
  return '<div class="files-table-wrap">' +
    '<table class="files-table">' +
      '<thead><tr>' +
        '<th style="width:40px;"><input type="checkbox" id="tbl-sel-all" ' + (allSel ? 'checked' : '') + '></th>' +
        '<th>课件名称</th>' +
        '<th style="width:110px;">格式类型</th>' +
        '<th style="width:100px;">文件体积</th>' +
        '<th style="width:90px;">规格/页数</th>' +
        '<th style="width:140px;">上传时间</th>' +
        '<th style="width:230px;">快捷操作</th>' +
      '</tr></thead>' +
      '<tbody>' +
        files.map(f => {
          const isSel = App.selectedFids.has(f.id);
          const isOffice = f.kind === 'office';
          return '<tr data-id="' + f.id + '" class="' + (isSel ? 'selected' : '') + '">' +
            '<td><input type="checkbox" class="tbl-row-chk" data-fid="' + f.id + '" ' + (isSel ? 'checked' : '') + '></td>' +
            '<td><div class="ft-name-cell">' + kindBadge(f) + '<span>' + UI.esc(f.name) + '</span></div></td>' +
            '<td>' + (f.ext || (f.kind === 'board' ? '白板' : '—')).toUpperCase() + '</td>' +
            '<td>' + (f.kind === 'board' ? '—' : UI.fmtSize(f.size)) + '</td>' +
            '<td>' + (f.pages ? f.pages + ' 页' : (f.kind === 'board' ? '无限画布' : '—')) + '</td>' +
            '<td class="muted">' + UI.fmtDate(f.created_at) + '</td>' +
            '<td><div class="ft-acts">' +
              (isOffice ? '<button class="btn xs" data-a="open">' + UI.icon('eye', 13) + ' 预览</button>' : '') +
              '<button class="btn xs primary" data-a="present">' + UI.icon('play', 13) + ' 放映</button>' +
              (isOffice ? '<button class="btn xs soft" data-a="local" title="本地Office打开">' + UI.icon('external', 13) + ' 本地</button>' : '') +
              '<button class="btn xs ghost" data-a="inspect" title="详情">' + UI.icon('info', 13) + '</button>' +
              '<button class="btn xs danger" data-a="del" title="删除">' + UI.icon('trash', 13) + '</button>' +
            '</div></td>' +
          '</tr>';
        }).join('') +
      '</tbody>' +
    '</table>' +
  '</div>';
}

function bindFileTableEvents() {
  const tbl = $('.files-table');
  if (!tbl) return;

  const selAll = $('#tbl-sel-all');
  if (selAll) {
    selAll.onchange = e => {
      const checked = e.target.checked;
      App.filteredFiles.forEach(f => {
        if (checked) App.selectedFids.add(f.id);
        else App.selectedFids.delete(f.id);
      });
      updateBatchBar();
      renderFileList();
    };
  }

  $$('.tbl-row-chk', tbl).forEach(chk => {
    chk.onclick = e => {
      e.stopPropagation();
      toggleSelectFile(+chk.dataset.fid);
    };
  });

  $$('tbody tr', tbl).forEach(tr => {
    const fid = +tr.dataset.id;
    const f = App.files.find(x => x.id === fid);
    if (!f) return;

    tr.onclick = e => {
      if (e.target.closest('input') || e.target.closest('button')) return;
      openFileDrawer(f);
    };

    $$('.ft-acts button', tr).forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        handleFileAction(btn.dataset.a, f);
      };
    });
  });
}

function toggleSelectFile(fid) {
  if (App.selectedFids.has(fid)) App.selectedFids.delete(fid);
  else App.selectedFids.add(fid);
  updateBatchBar();
  renderFileList();
}

function updateBatchBar() {
  const bar = $('#batch-bar');
  const count = $('#batch-count');
  if (!bar || !count) return;
  const num = App.selectedFids.size;
  if (num > 0) {
    count.textContent = '已选 ' + num + ' 项课件';
    bar.classList.add('show');
  } else {
    bar.classList.remove('show');
  }
}

async function batchDelete() {
  const count = App.selectedFids.size;
  if (!count) return;
  const ok = await UI.confirm('确定批量删除已选择的 ' + count + ' 个课件？删除后无法恢复。');
  if (!ok) return;

  const fids = Array.from(App.selectedFids);
  let succ = 0;
  for (const fid of fids) {
    try {
      await API.del('/api/files/' + fid);
      succ++;
    } catch (e) {}
  }
  App.selectedFids.clear();
  updateBatchBar();
  toast('已成功删除 ' + succ + ' 个课件', 'ok');
  refreshList(); refreshMe();
}

function batchDownload() {
  const fids = Array.from(App.selectedFids);
  if (!fids.length) return;
  toast('正在启动 ' + fids.length + ' 个文件下载…', 'ok');
  fids.forEach((fid, idx) => {
    setTimeout(() => {
      window.open('/api/files/' + fid + '/download?token=' + encodeURIComponent(API.token), '_blank');
    }, idx * 250);
  });
}

/* ================================================================
 *  7. 课件详情侧边抽屉 (Inspector Drawer)
 * ================================================================ */
function openFileDrawer(f) {
  App.inspectingFile = f;
  const drawer = $('#file-drawer');
  const backdrop = $('#drawer-backdrop');
  if (!drawer || !backdrop) return;

  const ext = ((f.name || '').split('.').pop() || '').toLowerCase();
  const isOffice = f.kind === 'office' && /^(ppt|pptx|doc|docx|xls|xlsx)$/.test(ext);

  drawer.innerHTML =
    '<div class="fd-head">' +
      '<b style="font-size:16px;">课件详情</b>' +
      '<button class="icon-btn" id="fd-close" type="button" style="width:30px;height:30px;">×</button>' +
    '</div>' +
    '<div class="fd-body">' +
      '<div class="fd-preview-box">' +
        kindBadge(f) +
      '</div>' +
      '<div style="margin-bottom:18px;">' +
        '<div style="font-size:17px;font-weight:700;color:var(--ink);line-height:1.4;margin-bottom:6px;" id="fd-title">' + UI.esc(f.name) + '</div>' +
        '<button class="btn xs ghost" id="fd-rename-btn" style="color:var(--brand);">' + UI.icon('edit', 12) + ' 重命名</button>' +
      '</div>' +
      '<div class="fd-row"><span>文件类型</span><b>' + (ext || f.kind).toUpperCase() + '</b></div>' +
      '<div class="fd-row"><span>文件体积</span><b>' + (f.kind === 'board' ? '无限画布' : UI.fmtSize(f.size)) + '</b></div>' +
      '<div class="fd-row"><span>幻灯页数</span><b>' + (f.pages ? f.pages + ' 页' : '—') + '</b></div>' +
      '<div class="fd-row"><span>上传日期</span><b>' + UI.fmtDate(f.created_at) + '</b></div>' +
      '<div style="display:flex;flex-direction:column;gap:10px;margin-top:20px;">' +
        '<button class="btn primary" id="fd-act-present">' + UI.icon('play', 15) + ' 全屏互动放映</button>' +
        (isOffice ? '<button class="btn" id="fd-act-open">' + UI.icon('eye', 15) + ' 在线纯净预览</button>' : '') +
        (isOffice ? '<button class="btn soft" id="fd-act-local">' + UI.icon('external', 15) + ' 调起本地Office放映</button>' : '') +
        (f.kind !== 'board' ? '<button class="btn ghost" id="fd-act-link">' + UI.icon('link', 15) + ' 复制公开免登录直链</button>' : '') +
        (f.kind !== 'board' ? '<button class="btn ghost" id="fd-act-dl">' + UI.icon('download', 15) + ' 下载到电脑</button>' : '') +
        '<button class="btn danger" id="fd-act-del">' + UI.icon('trash', 15) + ' 删除课件</button>' +
      '</div>' +
      '<div class="fd-qr-box" id="fd-qr-box">' +
        '<div style="font-size:12px;color:var(--mut);margin-bottom:8px;">手机扫码直达放映</div>' +
        '<div id="fd-qr"></div>' +
      '</div>' +
    '</div>';

  $('#fd-close').onclick = closeFileDrawer;
  $('#fd-rename-btn').onclick = () => renameFile(f);
  $('#fd-act-present').onclick = () => handleFileAction('present', f);
  if ($('#fd-act-open')) $('#fd-act-open').onclick = () => handleFileAction('open', f);
  if ($('#fd-act-local')) $('#fd-act-local').onclick = () => handleFileAction('local', f);
  if ($('#fd-act-link')) $('#fd-act-link').onclick = () => handleFileAction('link', f);
  if ($('#fd-act-dl')) $('#fd-act-dl').onclick = () => handleFileAction('dl', f);
  $('#fd-act-del').onclick = () => handleFileAction('del', f);

  // 渲染直链二维码
  const qrBox = $('#fd-qr');
  if (qrBox) {
    const directUrl = location.origin + '/present.html?fid=' + f.id + '&token=' + encodeURIComponent(API.token);
    UI.renderQR(qrBox, directUrl, 130);
  }

  drawer.classList.add('open');
  backdrop.classList.add('open');
}

function closeFileDrawer() {
  const drawer = $('#file-drawer');
  const backdrop = $('#drawer-backdrop');
  if (drawer) drawer.classList.remove('open');
  if (backdrop) backdrop.classList.remove('open');
  App.inspectingFile = null;
}

/* ================================================================
 *  8. 课件单个动作调度
 * ================================================================ */
async function handleFileAction(a, f) {
  if (a === 'inspect') {
    openFileDrawer(f);
  }
  if (a === 'open') {
    openFile(f);
  }
  if (a === 'present') {
    const ext = ((f.name || '').split('.').pop() || '').toLowerCase();
    const ms = f.kind === 'office' && /^(ppt|pptx|doc|docx|xls|xlsx)$/.test(ext);
    const trk = ms ? '&track=ms' : '';
    window.open('/present.html?fid=' + f.id + '&token=' + encodeURIComponent(API.token) + trk, '_blank');
  }
  if (a === 'local') {
    openLocalFile(f);
  }
  if (a === 'dl') {
    window.open('/api/files/' + f.id + '/download?token=' + API.token, '_blank');
  }
  if (a === 'link') {
    API.get('/api/files/' + f.id + '/share-link').then(r => {
      const direct = r.direct || (location.origin + r.path);
      copyText(direct).then(() => toast('直链已复制: ' + direct, 'ok')).catch(() => toast(direct));
    }).catch(err => toast(err.message, 'err'));
  }
  if (a === 'rename') {
    renameFile(f);
  }
  if (a === 'retry') {
    API.post('/api/files/' + f.id + '/retry').then(() => { toast('已重新开始转换', 'ok'); refreshList(); }).catch(err => toast(err.message, 'err'));
  }
  if (a === 'del') {
    const ok = await UI.confirm('确定删除《' + UI.esc(f.name) + '》？删除后无法恢复');
    if (!ok) return;
    API.del('/api/files/' + f.id).then(() => {
      toast('已删除', 'ok');
      closeFileDrawer();
      refreshList(); refreshMe();
    }).catch(err => toast(err.message, 'err'));
  }
}

async function renameFile(f) {
  const m = UI.modal({
    title: '重命名课件',
    body: '<label>课件名称<input id="ren-input" value="' + UI.esc(f.name) + '"></label>'
  });
  m.foot.innerHTML = '<button class="btn" id="ren-cancel">取消</button><button class="btn primary" id="ren-save">保存</button>';
  m.foot.querySelector('#ren-cancel').onclick = m.close;
  m.foot.querySelector('#ren-save').onclick = async () => {
    const newName = $('#ren-input').value.trim();
    if (!newName) { toast('名称不能为空', 'err'); return; }
    try {
      await API.patch('/api/files/' + f.id, { name: newName });
      toast('重命名成功', 'ok');
      m.close();
      f.name = newName;
      if ($('#fd-title')) $('#fd-title').textContent = newName;
      renderFileList();
    } catch (e) { toast(e.message, 'err'); }
  };
}

async function refreshMe() {
  try { App.user = await API.get('/api/auth/me'); renderStorage(); } catch (e) { }
}

function renderStorage() {
  const el = $('#storage'); if (!el) return;
  const u = App.user;
  const pct = Math.min(100, Math.round(u.used_bytes / u.quota_bytes * 100));
  el.innerHTML = '<div class="storage"><div class="sbar"><i style="width:' + pct + '%"></i></div><span>' +
    UI.fmtSize(u.used_bytes) + ' / ' + UI.fmtSize(u.quota_bytes) + '</span></div>';
}

function copyText(t) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t);
  return new Promise((res, rej) => {
    const ta = document.createElement('textarea');
    ta.value = t; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy') ? res() : rej(new Error('copy fail')); }
    catch (e) { rej(e); } finally { ta.remove(); }
  });
}

async function refreshList() {
  let files = [];
  try { files = await API.get('/api/files'); } catch (e) { return; }
  App.files = files;
  applyFiltersAndSort();

  if (pollT) { clearInterval(pollT); pollT = null; }
  if (files.some(f => f.status === 'converting')) {
    pollT = setInterval(async () => {
      if (!$('#grid') && !$('.files-table')) { clearInterval(pollT); pollT = null; return; }
      try {
        App.files = await API.get('/api/files');
        applyFiltersAndSort();
      } catch(e){}
    }, 2500);
    App.setCleanup(() => { if (pollT) { clearInterval(pollT); pollT = null; } });
  }
}

async function uploadFiles(files) {
  for (const f of files) {
    if (!f.name) continue;
    const item = UI.h('<div class="upitem"><div class="row"><span class="nm">' + UI.esc(f.name) + '</span><span class="pct">0%</span></div>' +
      '<div class="pbar"><i></i></div><div class="msg"></div></div>');
    $('#uplist').appendChild(item);
    const form = new FormData();
    form.append('file', f, f.name);
    try {
      await API.upload('/api/files/upload', form, pct => {
        item.querySelector('.pct').textContent = pct + '%';
        item.querySelector('.pbar i').style.width = pct + '%';
      });
      item.querySelector('.pbar i').style.width = '100%';
      item.querySelector('.pct').textContent = '完成';
      setTimeout(() => item.remove(), 2200);
      refreshList(); refreshMe();
    } catch (err) {
      item.classList.add('err');
      item.querySelector('.pct').textContent = '失败';
      item.querySelector('.msg').textContent = err.message;
    }
  }
}

/* ================================================================
 *  9. 专属桌面端中心 (Windows 客户端一键下载与连接)
 * ================================================================ */
async function viewDesktopCenter() {
  document.title = '桌面客户端中心 - FLA';
  const ready = await probeDesktopClient();

  const statusBadge = ready
    ? '<div class="dh-status-badge online"><span class="dh-dot online"></span> 客户端已连接 · 127.0.0.1:8307 桥接正常</div>'
    : '<div class="dh-status-badge offline"><span class="dh-dot offline"></span> 未检测到本地客户端运行 (即下即用，单文件免安装)</div>';

  $('#app').innerHTML = shell(
    '<div class="desktop-hub">' +
      '<div class="dh-hero">' +
        '<div class="dh-hero-left">' +
          statusBadge +
          '<h1>FLA 智慧课堂桌面助手</h1>' +
          '<p>专为多媒体讲台与智慧黑板深度研发。智能压制希沃白板5霸屏工具栏，深度挂接 PowerPoint / WPS 翻页与随页板书移动，支持手机无线扫码投屏与双向遥控。</p>' +
          '<div style="display:flex;gap:12px;margin-top:24px;flex-wrap:wrap;">' +
            '<a href="/api/desktop/download" class="dh-dl-btn">' +
              UI.icon('download', 20) + ' 立即下载 Windows 单文件版 (FLA.exe)' +
            '</a>' +
            '<button class="btn lg" id="btn-test-desktop" style="background:rgba(255,255,255,0.1);color:#fff;border-color:rgba(255,255,255,0.2);">' +
              UI.icon('refresh', 16) + ' 测试唤起本地客户端' +
            '</button>' +
          '</div>' +
        '</div>' +
        '<div class="dh-hero-actions">' +
          '<div style="background:rgba(0,0,0,0.3);padding:18px 24px;border-radius:14px;border:1px solid rgba(255,255,255,0.1);text-align:right;">' +
            '<div style="font-size:12px;color:#94a3b8;">当前分发版本</div>' +
            '<div style="font-size:22px;font-weight:800;color:#ffffff;">v1.36.0</div>' +
            '<div style="font-size:12px;color:#cbd5e1;margin-top:4px;">单文件绿色免安装 · 启动自动静默更新</div>' +
          '</div>' +
        '</div>' +
      '</div>' +

      '<div>' +
        '<h2 style="font-size:22px;margin-bottom:16px;">核心教学赋能特性</h2>' +
        '<div class="dh-grid">' +
          '<div class="dh-card">' +
            '<div class="dh-card-icon">' + UI.icon('lock', 24) + '</div>' +
            '<h3>希沃白板5 智能压制拦截</h3>' +
            '<p>毫秒级检测并静默拦截希沃白板5（EasiNote）在 PPT 放映时强制注入的多余悬浮工具条与弹窗干扰，还给教师最纯净的原生演示体验。</p>' +
          '</div>' +

          '<div class="dh-card">' +
            '<div class="dh-card-icon">' + UI.icon('board', 24) + '</div>' +
            '<h3>板书笔迹与幻灯片翻页严格联动</h3>' +
            '<p>深度挂接 Office COM 接口，精准捕捉实时页码。板书笔迹随 PPT 翻页严格按页隔离存储与移动，翻页永不错位、不串页。</p>' +
          '</div>' +

          '<div class="dh-card">' +
            '<div class="dh-card-icon">' + UI.icon('qr', 24) + '</div>' +
            '<h3>手机扫码双向无线遥控</h3>' +
            '<p>老师无需安装任何 App，手机微信扫一扫即可变成激光笔遥控器。大尺寸触控板、翻页步进、黑屏与白板一键切换。</p>' +
          '</div>' +

          '<div class="dh-card">' +
            '<div class="dh-card-icon">' + UI.icon('refresh', 24) + '</div>' +
            '<h3>单 EXE 免安装与原地静默更新</h3>' +
            '<p>单文件免安装即开即用，每次启动自动比对服务端版本并原地静默更新，学校管理员与教师永无需再去官网手动重复下载重装。</p>' +
          '</div>' +

          '<div class="dh-card">' +
            '<div class="dh-card-icon">' + UI.icon('palette', 24) + '</div>' +
            '<h3>7种专业学科背景白板与工具箱</h3>' +
            '<p>田字格、四线三格、五线谱、坐标网格、护眼绿与纯白黑板。内置课堂倒计时、秒表、随机抽选点名神器与四向遮挡幕布。</p>' +
          '</div>' +

          '<div class="dh-card">' +
            '<div class="dh-card-icon">' + UI.icon('external', 24) + '</div>' +
            '<h3>网页控制台一键调起本地 Office</h3>' +
            '<p>在网页课件库点击「本地打开」，瞬间由本地 8307 桥接服务直接调起系统默认 PowerPoint / WPS 原生全屏放映，无需重复下载。</p>' +
          '</div>' +
        '</div>' +
      '</div>' +

      '<div class="card" style="padding:24px;border-radius:16px;">' +
        '<h3>使用指南与协议注册</h3>' +
        '<div style="font-size:14px;color:var(--ink-secondary);line-height:1.7;margin-top:10px;">' +
          '<p>1. <b>下载客户端：</b>点击上方按钮直接下载 <code>FLA.exe</code>，单文件双击即可直接运行；</p>' +
          '<p>2. <b>右键托盘图标：</b>客户端启动后会在系统右下角托盘驻留，提供悬浮教学工具栏、开机自启、协议注册等选项；</p>' +
          '<p>3. <b>网页联动：</b>在网页课件库点击「本地打开」，系统会自动发送命令给本地运行的 FLA.exe，瞬间放映课件。</p>' +
        '</div>' +
      '</div>' +
    '</div>',
    'desktop'
  );

  bindLogout();

  $('#btn-test-desktop').onclick = async () => {
    toast('正在测试探测本地 127.0.0.1:8307 端口…');
    const ok = await probeDesktopClient();
    if (ok) toast('连接成功！本地 FLA 桌面客户端正在良好运行中 ✓', 'ok');
    else {
      toast('未检测到本地客户端，请先下载并运行 FLA.exe', 'warn');
      window.location.href = 'fla://open?test=1';
    }
  };
}

/* ================================================================
 *  10. 官方门户 / 官网主页 (viewHome)
 * ================================================================ */
function viewHome() {
  document.title = 'FLA · 现代化多媒体互动教学系统';
  const u = App.user;
  const navUserSection = u
    ? '<a href="#/library" class="btn primary sm home-nav-dl">' + UI.icon('folder', 14) + ' <span>进入控制台</span></a>'
    : '<a href="#/login" class="home-link">登录</a>' +
      '<a href="#/register" class="home-link">注册</a>' +
      '<a href="/api/desktop/download" class="btn primary sm home-nav-dl">' + UI.icon('download', 14) + ' <span>下载客户端</span></a>';

  const heroActions = u
    ? '<a href="/api/desktop/download" class="btn primary lg home-btn-dl">' +
        UI.icon('download', 18) +
        '<span><strong>立即下载 Windows 客户端</strong><small>单文件 EXE · 免安装 · 启动自动更新</small></span>' +
      '</a>' +
      '<a href="#/library" class="btn lg home-btn-portal">' + UI.icon('folder', 16) + ' 进入课件工作台</a>' +
      '<a href="#/remote" class="btn soft lg home-btn-reg">' + UI.icon('qr', 15) + ' 手机扫码遥控</a>'
    : '<a href="/api/desktop/download" class="btn primary lg home-btn-dl">' +
        UI.icon('download', 18) +
        '<span><strong>立即下载 Windows 客户端</strong><small>单文件 EXE · 免安装 · 启动自动更新</small></span>' +
      '</a>' +
      '<a href="#/login" class="btn lg home-btn-portal">' + UI.icon('external', 16) + ' 登录网页控制台</a>' +
      '<a href="#/register" class="btn soft lg home-btn-reg">注册新账号</a>' +
      '<a href="#/remote" class="btn soft lg home-btn-reg">' + UI.icon('qr', 15) + ' 手机遥控</a>';

  $('#app').innerHTML =
    '<div class="home-portal">' +
      '<header class="home-nav">' +
        '<div class="home-nav-inner">' +
          '<a href="#/home" class="home-brand">' +
            '<div class="home-logo">' + UI.icon('board', 22) + '</div>' +
            '<div class="home-title-box">' +
              '<span class="home-title">FLA</span>' +
              '<span class="home-badge">智慧互动教学系统</span>' +
            '</div>' +
          '</a>' +
          '<div class="home-nav-links">' +
            '<a href="#features" class="home-link" id="nav-features-link">核心功能</a>' +
            '<a href="#/desktop" class="home-link">桌面端中心</a>' +
            '<a href="#/remote" class="home-link">手机遥控</a>' +
            navUserSection +
          '</div>' +
        '</div>' +
      '</header>' +

      '<main class="home-main">' +
        '<section class="home-hero">' +
          '<div class="home-hero-badge"><span class="home-pulse"></span> 全新 v1.36.0 智慧教学互动套件正式发布</div>' +
          '<h1 class="home-hero-title">新一代智慧多媒体教学终端<br>专为高效课堂与互动授课而生</h1>' +
          '<p class="home-hero-desc">无缝打通云端课件库、纯净在线预览、希沃白板5智能拦截、PPT随页板书联动与手机多维无线遥控。<br>单文件免安装，支持服务端检测原地静默升级。</p>' +
          '<div class="home-hero-actions">' + heroActions + '</div>' +
          '<div class="home-hero-meta">' +
            '<span>' + UI.icon('check', 14) + ' 免登录直接下载</span>' +
            '<span>' + UI.icon('check', 14) + ' 希沃白板5自动拦截压制</span>' +
            '<span>' + UI.icon('check', 14) + ' 画布随 PPT 翻页严格同步</span>' +
            '<span>' + UI.icon('check', 14) + ' 手机无线扫码投屏与遥控</span>' +
          '</div>' +
        '</section>' +

        '<section class="home-section" id="features">' +
          '<div class="home-sec-head">' +
            '<h2>卓越教学特性</h2>' +
            '<p>聚焦教学授课核心需求，剔除臃肿与干扰，提供极简、顺畅的软硬件协同体验</p>' +
          '</div>' +
          '<div class="home-grid">' +
            '<div class="home-card">' +
              '<div class="home-card-icon">' + UI.icon('lock', 22) + '</div>' +
              '<h3>希沃白板5 智能静默拦截</h3>' +
              '<p>毫秒级检测并抑制希沃白板5强制注入的多余浮动工具栏与广告干扰，替代为 FLA 极简专业工具条与专属防伪水印。</p>' +
            '</div>' +
            '<div class="home-card">' +
              '<div class="home-card-icon">' + UI.icon('board', 22) + '</div>' +
              '<h3>板书笔迹与幻灯片翻页严格联动</h3>' +
              '<p>深度挂接 Office COM 接口，精准捕捉放映页码。板书随翻页按页独立隔离保存，翻页前进后退永不错位。</p>' +
            '</div>' +
            '<div class="home-card">' +
              '<div class="home-card-icon">' + UI.icon('qr', 22) + '</div>' +
              '<h3>手机扫码无线遥控与投屏</h3>' +
              '<p>无需安装任何 App，教师手机扫码即可成为掌上遥控器。支持激光笔触控板、幻灯片步进、全屏黑屏与课堂白板。</p>' +
            '</div>' +
            '<div class="home-card">' +
              '<div class="home-card-icon">' + UI.icon('eye', 22) + '</div>' +
              '<h3>轻量纯净的 Office 在线预览</h3>' +
              '<p>去除所有冗余编辑栏，专心呈现课件预览。同时支持在网页端一键直连调起本地系统默认 PowerPoint / WPS 原生演示。</p>' +
            '</div>' +
            '<div class="home-card">' +
              '<div class="home-card-icon">' + UI.icon('refresh', 22) + '</div>' +
              '<h3>单 EXE 运行与原地静默更新</h3>' +
              '<p>纯净轻量单文件设计，双击直接运行。每次启动自动比对服务端版本并原地静默替换，彻底告别手动去官网重新下载。</p>' +
            '</div>' +
            '<div class="home-card">' +
              '<div class="home-card-icon">' + UI.icon('users', 22) + '</div>' +
              '<h3>微信级群组交流与课件互动</h3>' +
              '<p>内置微信级课堂交流、课件点对点分享、@提醒、随机抽人点名与倒计时闹钟，一站式赋能智慧互动课堂。</p>' +
            '</div>' +
          '</div>' +
        '</section>' +

        '<section class="home-section">' +
          '<div class="home-dl-box">' +
            '<div class="home-dl-left">' +
              '<h2>立即体验 Windows 桌面端</h2>' +
              '<p>轻量无捆绑 · 专为多媒体教室与多功能一体机定制优化 · 极低资源占用</p>' +
              '<div class="home-dl-tags">' +
                '<span class="home-dl-tag">Windows 10 / 11 兼容</span>' +
                '<span class="home-dl-tag">Microsoft Office / WPS 自动识别</span>' +
                '<span class="home-dl-tag">支持本地 8307 网页直接唤起</span>' +
              '</div>' +
            '</div>' +
            '<div class="home-dl-right">' +
              '<a href="/api/desktop/download" class="btn primary lg home-btn-dl-pulse">' +
                UI.icon('download', 20) + ' 免费免登录直接下载 (FLA.exe)' +
              '</a>' +
              '<a href="/api/desktop/version" target="_blank" class="home-ver-link">查看服务端版本更新日志 (JSON)</a>' +
            '</div>' +
          '</div>' +
        '</section>' +
      '</main>' +

      '<footer class="home-footer">' +
        '<div class="home-footer-inner">' +
          '<div class="home-footer-brand">' + UI.icon('board', 18) + ' FLA 智慧教学互动系统</div>' +
          '<p>© ' + new Date().getFullYear() + ' FLA Project. 保留所有权利 · 专为教育教学优化</p>' +
          '<div class="home-footer-links">' +
            '<a href="#/login">用户登录</a>' +
            '<a href="#/register">注册账号</a>' +
            '<a href="#/desktop">桌面端中心</a>' +
            '<a href="#/remote">手机遥控</a>' +
            '<a href="/api/desktop/download">客户端下载</a>' +
          '</div>' +
        '</div>' +
      '</footer>' +
    '</div>';

  const fLink = $('#nav-features-link');
  if (fLink) {
    fLink.onclick = e => {
      e.preventDefault();
      const sec = $('#features');
      if (sec) sec.scrollIntoView({ behavior: 'smooth' });
    };
  }
}

/* ================================================================
 *  11. 登录 / 注册 / 扫码登录
 * ================================================================ */
function viewLogin() {
  document.title = '登录 - FLA';
  const regLink = '<p class="auth-foot" style="margin-top:16px;font-size:13px;color:var(--mut);">还没有账号？<a href="#/register">使用邀请码注册</a></p><p class="auth-extra-links"><a href="#/home">返回官网首页</a> · <a href="/api/desktop/download">下载 Windows 客户端</a></p>';
  $('#app').innerHTML =
    '<div class="auth-bg"><div class="auth-card modal" style="max-width:380px;margin:auto;padding:32px 28px;background:#fff;border-radius:18px;box-shadow:var(--shadow-xl);">' +
    '<div class="auth-logo" style="text-align:center;margin-bottom:12px;color:var(--brand);">' + UI.icon('board', 38) + '</div>' +
    '<h1 style="text-align:center;font-size:24px;margin-bottom:4px;">FLA</h1><p class="sub" style="text-align:center;color:var(--mut);font-size:13.5px;margin-bottom:20px;">教学课件与互动白板系统</p>' +
    '<div class="auth-tabs view-toggle" style="margin-bottom:18px;"><button class="view-toggle-btn active" id="lt-pw" style="flex:1;">密码登录</button><button class="view-toggle-btn" id="lt-qr" style="flex:1;">' + UI.icon('qr', 14) + ' 扫码登录</button></div>' +
    '<form id="f">' +
    '<label>用户名<input name="username" autocomplete="username" required></label>' +
    '<label>密码<input name="password" type="password" autocomplete="current-password" required></label>' +
    '<button class="btn primary block" type="submit" style="margin-top:16px;">登 录</button></form>' +
    '<div id="qrbox" class="qr-login hidden" style="text-align:center;padding:16px 0;">' +
    '<div class="qr-holder" id="qr-holder" style="display:flex;justify-content:center;margin-bottom:12px;"><div class="qr-spin"></div></div>' +
    '<p class="qr-tip" style="font-size:13px;color:var(--ink2);">用<b>已登录 FLA 的设备</b>扫码授权登录</p>' +
    '<p class="qr-tip muted" style="font-size:12px;color:var(--mut);">登录页二维码每 2 分钟自动刷新</p>' +
    '</div>' +
    regLink +
    '</div></div>';

  $('#f').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const r = await API.post('/api/auth/login', { username: String(fd.get('username')).trim(), password: String(fd.get('password')) });
      API.setToken(r.token); App.user = r.user;
      afterLoginGo();
    } catch (err) { toast(err.message, 'err'); }
  };

  let qrTimers = [];
  function stopQrLogin() { qrTimers.forEach(t => clearInterval(t) || clearTimeout(t)); qrTimers = []; }
  async function startQrLogin() {
    stopQrLogin();
    const holder = $('#qr-holder');
    if (!holder) return;
    holder.innerHTML = '<div class="qr-spin"></div>';

    let ticket = '';
    const refresh = async () => {
      try {
        const r = await API.post('/api/auth/qr/ticket', {});
        ticket = r.ticket;
        const url = r.url || (location.origin + '/#/qr-approve?ticket=' + encodeURIComponent(ticket));
        holder.innerHTML = '';
        if (r.qr_svg && r.qr_svg.trim().startsWith('<svg')) {
          holder.innerHTML = r.qr_svg;
          const svg = holder.querySelector('svg');
          if (svg) { svg.setAttribute('width', '190'); svg.setAttribute('height', '190'); svg.style.width = '190px'; svg.style.height = '190px'; }
        } else if (UI && UI.renderQR) {
          UI.renderQR(holder, url, 190);
        }
      } catch (e) {
        holder.innerHTML = '<div class="qr-err" style="color:var(--danger);font-size:13px;">加载二维码失败，请检查网络</div>';
      }
    };
    await refresh();
    qrTimers.push(setInterval(refresh, 120000));

    const poll = async () => {
      if (!ticket) return;
      try {
        const r = await API.get('/api/auth/qr/' + ticket);
        if (r.status === 'approved' && r.token) {
          stopQrLogin();
          API.setToken(r.token); App.user = r.user;
          toast('扫码授权成功 ✓', 'ok');
          afterLoginGo();
        } else if (r.status === 'invalid') {
          refresh();
        }
      } catch (e) { }
    };
    qrTimers.push(setInterval(poll, 1500));
  }

  const switchTab = qr => {
    $('#lt-pw').classList.toggle('active', !qr);
    $('#lt-qr').classList.toggle('active', qr);
    const f = $('#f'), qb = $('#qrbox');
    if (f) f.style.display = qr ? 'none' : 'block';
    if (qb) qb.style.display = qr ? 'block' : 'none';
    if (qr) startQrLogin(); else stopQrLogin();
  };
  if ($('#lt-pw')) $('#lt-pw').onclick = () => switchTab(false);
  if ($('#lt-qr')) $('#lt-qr').onclick = () => switchTab(true);
  switchTab(false);
}

function afterLoginGo() {
  let back = '';
  try { back = sessionStorage.getItem('fla_after_login') || ''; sessionStorage.removeItem('fla_after_login'); } catch (e) { }
  const target = back || '#/library';
  if (location.hash === target) {
    route();
  } else {
    location.hash = target;
  }
}

async function viewRegister() {
  document.title = '注册 - FLA';
  let open = true;
  try { open = (await API.get('/api/auth/config')).registration_open; } catch (e) { }
  if (!open) {
    $('#app').innerHTML = '<div class="auth-bg"><div class="auth-card modal" style="max-width:380px;margin:auto;padding:32px;background:#fff;border-radius:18px;"><h1>注册未开放</h1><p class="sub">请联系管理员获取邀请码或直接分配账号</p><p class="auth-foot"><a href="#/login">返回登录</a></p></div></div>';
    return;
  }
  $('#app').innerHTML =
    '<div class="auth-bg"><div class="auth-card modal" style="max-width:380px;margin:auto;padding:32px 28px;background:#fff;border-radius:18px;box-shadow:var(--shadow-xl);">' +
    '<div class="auth-logo" style="text-align:center;margin-bottom:12px;color:var(--brand);">' + UI.icon('board', 38) + '</div>' +
    '<h1 style="text-align:center;font-size:24px;margin-bottom:4px;">注册账号</h1><p class="sub" style="text-align:center;color:var(--mut);font-size:13.5px;margin-bottom:20px;">FLA 智慧互动教学系统</p>' +
    '<form id="f">' +
    '<label>用户名<input name="username" autocomplete="username" minlength="2" maxlength="32" required placeholder="用于登录"></label>' +
    '<label>姓名 / 昵称<input name="nickname" maxlength="32" required placeholder="课件与互动展示名称"></label>' +
    '<label>密码<input name="password" type="password" minlength="6" autocomplete="new-password" required placeholder="至少 6 位"></label>' +
    '<label>邀请码 (可选)<input name="invite_code" placeholder="输入教师认证邀请码"></label>' +
    '<button class="btn primary block" type="submit" style="margin-top:16px;">注 册</button></form>' +
    '<p class="auth-foot" style="margin-top:16px;font-size:13px;color:var(--mut);text-align:center;">已有账号？<a href="#/login">立即登录</a></p>' +
    '<p class="auth-extra-links"><a href="#/home">返回官网首页</a> · <a href="/api/desktop/download">下载 Windows 客户端</a></p>' +
    '</div></div>';
  $('#f').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const r = await API.post('/api/auth/register', {
        username: String(fd.get('username')).trim(),
        nickname: String(fd.get('nickname')).trim(),
        password: String(fd.get('password')),
        invite_code: String(fd.get('invite_code') || '').trim() || null,
      });
      API.setToken(r.token); App.user = r.user;
      toast('注册成功，欢迎使用 FLA', 'ok');
      location.hash = '#/library';
    } catch (err) { toast(err.message, 'err'); }
  };
}

/* ================================================================
 *  12. 个人中心与资料修改 (viewProfile)
 * ================================================================ */
async function viewProfile() {
  document.title = '个人中心 - FLA';
  try { App.user = await API.get('/api/auth/me'); } catch (e) { return; }
  const u = App.user;
  $('#app').innerHTML = shell(
    (u.must_change_password ? '<div class="warnbar" style="background:#fffbeb;border:1px solid #fef3c7;color:#b45309;padding:12px 16px;border-radius:10px;margin-bottom:16px;">⚠ 当前使用初始密码，请尽快修改</div>' : '') +
    '<div class="profile-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:20px;">' +
    '<div class="card p-card" style="padding:24px;border-radius:16px;background:#fff;border:1px solid var(--line);box-shadow:var(--shadow-sm);"><h3>个人资料</h3>' +
    '<div class="avatar-big" id="avwrap" style="text-align:center;margin:16px 0 10px;">' + avatarHTML(u, 84) + '</div>' +
    '<div style="text-align:center;margin-bottom:14px;"><button class="btn sm" id="avbtn">更换头像</button><input type="file" id="avin" hidden accept="image/png,image/jpeg,image/webp,image/gif"></div>' +
    '<label>昵称<input id="nk" maxlength="32" value="' + UI.esc(u.nickname) + '"></label>' +
    '<label>个性签名<textarea id="sg" maxlength="200" rows="3" placeholder="写点什么介绍自己…">' + UI.esc(u.signature) + '</textarea></label>' +
    '<div style="margin:20px 0;">' + certCardHTML(u) + '</div>' +
    '<button class="btn primary" id="savep">保存资料</button></div>' +

    '<div class="card p-card" style="padding:24px;border-radius:16px;background:#fff;border:1px solid var(--line);box-shadow:var(--shadow-sm);"><h3>账号与安全</h3>' +
    '<div class="kv" style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line);font-size:13.5px;"><span>用户名</span><b>' + UI.esc(u.username) + '</b></div>' +
    '<div class="kv" style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line);font-size:13.5px;"><span>角色</span><b>' + (u.role === 'admin' ? '管理员' : '教师用户') + '</b></div>' +
    '<div class="kv" style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line);font-size:13.5px;"><span>存储空间</span><b>' + UI.fmtSize(u.used_bytes) + ' / ' + UI.fmtSize(u.quota_bytes) + '</b></div>' +
    '<div class="kv" style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line);font-size:13.5px;"><span>注册时间</span><b>' + UI.fmtDate(u.created_at) + '</b></div>' +
    '<hr><h3>修改密码</h3>' +
    '<label>原密码<input id="pw0" type="password" autocomplete="current-password"></label>' +
    '<label>新密码<input id="pw1" type="password" minlength="6" autocomplete="new-password"></label>' +
    '<label>确认新密码<input id="pw2" type="password" minlength="6" autocomplete="new-password"></label>' +
    '<button class="btn" id="savepw" style="margin-top:12px;">修改密码</button></div>' +
    '</div>', 'profile');
  bindLogout();
  bindCertCards();

  $('#avbtn').onclick = () => $('#avin').click();
  $('#avin').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    const form = new FormData(); form.append('file', f, f.name || 'avatar.png');
    try {
      const r = await API.upload('/api/users/avatar', form);
      $('#avwrap').innerHTML = '<img class="avatar" style="width:84px;height:84px;border-radius:50%;object-fit:cover;" src="' + UI.esc(r.avatar) + '">';
      toast('头像已更新', 'ok');
    } catch (err) { toast(err.message, 'err'); }
    e.target.value = '';
  };
  $('#savep').onclick = async () => {
    try {
      App.user = await API.put('/api/users/profile', { nickname: $('#nk').value, signature: $('#sg').value });
      toast('已保存', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#savepw').onclick = async () => {
    const p1 = $('#pw1').value, p2 = $('#pw2').value;
    if (p1 !== p2) { toast('两次输入的新密码不一致', 'err'); return; }
    try {
      await API.post('/api/auth/change_password', { old_password: $('#pw0').value, new_password: p1 });
      toast('密码已修改', 'ok');
      $('#pw0').value = $('#pw1').value = $('#pw2').value = '';
    } catch (err) { toast(err.message, 'err'); }
  };
}

/* ================================================================
 *  13. 打开课件与调用本地放映 (openFile / openLocalFile)
 * ================================================================ */
function openFile(f) {
  if (f.kind === 'board') { location.hash = '#/view/' + f.id; return; }
  const ext = ((f.name || '').split('.').pop() || '').toLowerCase();
  const ms = f.kind === 'office' && /^(ppt|pptx|doc|docx|xls|xlsx)$/.test(ext);
  if (ms) {
    location.hash = '#/view/' + f.id;
    return;
  }
  window.open('/present.html?fid=' + f.id + '&token=' + encodeURIComponent(API.token), '_blank');
}

async function openLocalFile(f) {
  toast('正在尝试调用本地放映…');
  let directUrl = location.origin + '/api/files/' + f.id + '/download?token=' + encodeURIComponent(API.token);
  try {
    const share = await API.get('/api/files/' + f.id + '/share-link');
    if (share && share.direct) directUrl = share.direct;
  } catch (e) {}

  const ext = ((f.name || '').split('.').pop() || '').toLowerCase();
  const isPpt = /^(ppt|pptx|pps|ppsx|dps)$/.test(ext);
  const isDoc = /^(doc|docx|rtf|wps)$/.test(ext);
  const isXls = /^(xls|xlsx|csv|et)$/.test(ext);
  const officeScheme = isPpt ? 'ms-powerpoint:ofe|u|' : isDoc ? 'ms-word:ofe|u|' : isXls ? 'ms-excel:ofe|u|' : '';

  // 1. 请求本地 127.0.0.1:8307
  let bridgeSuccess = false;
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 1200);
    const res = await fetch('http://127.0.0.1:8307/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fid: f.id,
        name: f.name,
        url: directUrl,
        token: API.token
      }),
      signal: ctrl.signal
    });
    clearTimeout(tid);
    const d = await res.json();
    if (d && d.ok) {
      toast(d.msg || '已成功调起本地桌面客户端放映！', 'ok');
      bridgeSuccess = true;
      return;
    }
  } catch (err) {}

  // 2. 本地 8307 客户端未启动：提供选择
  if (!bridgeSuccess) {
    const dlUrl = '/api/files/' + f.id + '/download?token=' + encodeURIComponent(API.token);
    if (officeScheme && directUrl.startsWith('http')) {
      try { window.location.href = officeScheme + encodeURI(directUrl); } catch (e) {}
    }

    UI.modal({
      title: '本地放映方式选择',
      body: '<div style="line-height:1.65;font-size:14px;color:#27272a;">' +
        '<p style="margin-bottom:8px;">课件 <b>《' + UI.esc(f.name) + '》</b> 支持以下本地播放方式：</p>' +
        '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px 16px;margin:12px 0;font-size:13px;color:#475569;">' +
          '<b>💡 推荐放映途径：</b><br>' +
          '1. <b>本地引擎放映：</b>无需安装任何 Office 软件，直接在浏览器中全屏放映并保留画笔、计时、抽选功能；<br>' +
          '2. <b>FLA 原生桌面客户端：</b>专为多媒体教室研发，自带云存储与投屏功能，启动零延迟。' +
        '</div>' +
        '<div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap;">' +
          '<button class="btn primary" id="modalLocalPresent" style="text-decoration:none;">' + UI.icon('play', 15) + ' 启动本地引擎放映</button>' +
          '<a href="' + dlUrl + '" class="btn" style="text-decoration:none;">' + UI.icon('download', 15) + ' 下载课件到本地</a>' +
          '<a href="/api/desktop/download" class="btn" style="text-decoration:none;">' + UI.icon('external', 15) + ' 下载桌面客户端</a>' +
        '</div>' +
      '</div>',
      width: '500px'
    });

    const lpBtn = document.getElementById('modalLocalPresent');
    if (lpBtn) {
      lpBtn.onclick = () => {
        window.open('/present.html?fid=' + f.id + '&token=' + encodeURIComponent(API.token) + '&track=local', '_blank');
      };
    }
  }
}

/* 站点背景 */
(function () {
  fetch('/api/auth/config').then(r => r.json()).then(c => {
    if (!c || !c.site_bg) return;
    if (/^#/.test(c.site_bg)) document.body.style.backgroundColor = c.site_bg;
    else if (/^(https?:\/\/|\/)/.test(c.site_bg)) {
      document.body.style.backgroundImage = 'url("' + c.site_bg + '")';
      document.body.style.backgroundSize = 'cover';
      document.body.style.backgroundPosition = 'center';
      document.body.style.backgroundAttachment = 'fixed';
    }
  }).catch(() => { });
})();

function loadScript(src) {
  return new Promise((res, rej) => {
    if (src.includes('qrcode') && window.QRCode) return res();
    if (src.includes('jsqr') && window.jsQR) return res();
    const cleanSrc = src.split('?')[0];
    const existing = document.querySelector('script[src*="' + cleanSrc + '"]') || document.querySelector('script[data-fla="' + cleanSrc + '"]');
    if (existing) {
      if (existing.getAttribute('data-loaded') === '1' || (src.includes('qrcode') && window.QRCode) || (src.includes('jsqr') && window.jsQR)) {
        return res();
      }
      existing.addEventListener('load', () => { existing.setAttribute('data-loaded', '1'); res(); });
      existing.addEventListener('error', () => rej(new Error('组件加载失败')));
      return;
    }
    const s = document.createElement('script');
    s.src = src; s.setAttribute('data-fla', cleanSrc);
    s.onload = () => { s.setAttribute('data-loaded', '1'); res(); };
    s.onerror = () => rej(new Error('组件加载失败'));
    document.head.appendChild(s);
  });
}

/* ---------- 公告 ---------- */
async function refreshAnnBadge() {
  if (!App.user) return;
  try {
    const r = await API.get('/api/announcements');
    App.ann = r;
    const dot = $('#ann-dot');
    if (dot) dot.classList.toggle('hidden', !r.unread);
  } catch (e) { }
}

async function openAnnPanel() {
  const r = await API.get('/api/announcements').catch(() => null);
  if (!r) return;
  const lv = { info: '公告', warn: '注意', imp: '重要' };
  const items = r.items.length ? r.items.map(a =>
    '<div class="ann-item ' + a.level + (a.read ? '' : ' unread') + '" style="padding:12px;margin-bottom:8px;border-radius:10px;background:var(--bg-subtle);">' +
    '<div class="ann-head" style="display:flex;justify-content:space-between;margin-bottom:6px;"><b>' + UI.esc(a.title) + '</b>' +
    (a.personal ? '<span class="ann-personal" style="color:var(--brand);font-size:11px;font-weight:700;">专属</span>' : '') +
    '<span class="ann-lv ' + a.level + '" style="font-size:11px;padding:2px 6px;border-radius:4px;background:#e2e8f0;">' + (lv[a.level] || '公告') + '</span></div>' +
    (a.content ? '<div class="ann-body" style="font-size:13.5px;color:var(--ink-secondary);line-height:1.5;">' + UI.esc(a.content).replace(/\n/g, '<br>') + '</div>' : '') +
    '<div class="ann-time" style="font-size:11.5px;color:var(--mut);margin-top:6px;">' + UI.fmtDate(a.created_at) + '</div></div>'
  ).join('') : '<div class="empty">暂无公告</div>';
  const m = UI.modal({ title: UI.icon('horn', 18) + ' 公告', titleHTML: true,
    body: '<div class="ann-list">' + items + '</div>' });
  const unread = r.items.filter(a => !a.read).map(a => a.id);
  if (unread.length) API.post('/api/announcements/read', { ids: unread }).then(refreshAnnBadge).catch(() => { });
  refreshAnnBadge();
}

/* ---------- 扫码(登录其他设备) ---------- */
async function openScanModal() {
  const m = UI.modal({ title: UI.icon('qr', 18) + ' 扫码登录其他设备', titleHTML: true,
    body: '<div class="scan-box" style="text-align:center;"><video id="scan-v" playsinline muted style="width:100%;max-width:280px;border-radius:12px;"></video>' +
    '<div class="scan-tip" id="scan-tip" style="margin-top:10px;font-size:13px;color:var(--mut);">正在启动相机…</div></div>' +
    '<div class="scan-manual" style="margin-top:14px;display:flex;gap:8px;align-items:center;"><span>手动输入票据:</span>' +
    '<input id="scan-ticket" placeholder="qr 开头的票据码">' +
    '<button class="btn sm" id="scan-go">授权</button></div>' });
  let stream = null, raf = 0, stop = false;
  const cleanup = () => { stop = true; cancelAnimationFrame(raf); if (stream) stream.getTracks().forEach(t => t.stop()); };
  m.el.addEventListener('mousedown', e => { if (e.target === m.el) cleanup(); }, { once: false });
  const tip = $('#scan-tip');
  const approve = async ticket => {
    ticket = (ticket || '').trim();
    if (!/^qr[0-9a-f]{16,}$/.test(ticket)) { toast('票据格式不对', 'err'); return false; }
    try {
      await API.post('/api/auth/qr/approve', { ticket });
      toast('已授权该设备登录 ✓', 'ok'); cleanup(); m.close();
      return true;
    } catch (e) { toast(e.message, 'err'); return false; }
  };
  $('#scan-go').onclick = () => approve($('#scan-ticket').value);
  try {
    await loadScript('/lib/jsqr/jsQR.js');
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const v = $('#scan-v'), cv = document.createElement('canvas'), cx = cv.getContext('2d');
    v.srcObject = stream; await v.play();
    tip.textContent = '对准另一台设备上的登录二维码';
    const loop = () => {
      if (stop || !v.videoWidth) { if (!stop) raf = requestAnimationFrame(loop); return; }
      cv.width = v.videoWidth; cv.height = v.videoHeight;
      cx.drawImage(v, 0, 0);
      const img = cx.getImageData(0, 0, cv.width, cv.height);
      const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
      if (code && code.data) {
        const mm = /qr-approve\?ticket=(qr[0-9a-f]{16,})/.exec(code.data);
        if (mm) { approve(mm[1]); return; }
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
  } catch (e) {
    tip.textContent = '相机不可用(' + (location.protocol === 'https:' ? '无摄像头' : '需 HTTPS') + ')。用手机扫码或在下方手动输入票据。';
  }
}

function viewQrApprove() {
  document.title = '扫码授权 - FLA';
  const q = new RegExp('[?&]ticket=([^&]*)').exec(location.hash);
  const ticket = q ? decodeURIComponent(q[1]) : '';
  if (!App.user) {
    try { sessionStorage.setItem('fla_after_login', location.hash); } catch (e) { }
    toast('请先登录, 登录后自动回到本页授权');
    location.hash = '#/login';
    return;
  }
  $('#app').innerHTML =
    '<div class="auth-bg"><div class="auth-card modal" style="max-width:380px;margin:auto;padding:32px 28px;background:#fff;border-radius:18px;box-shadow:var(--shadow-xl);">' +
    '<div class="auth-logo" style="text-align:center;color:var(--brand);margin-bottom:12px;">' + UI.icon('qr', 38) + '</div>' +
    '<h1 style="font-size:24px;text-align:center;margin-bottom:4px;">扫码登录授权</h1>' +
    '<p class="sub" style="text-align:center;color:var(--mut);font-size:13.5px;margin-bottom:18px;">' + UI.esc(App.user.nickname) + ' (' + UI.esc(App.user.username) + ')</p>' +
    '<div id="qr-approve-body">' +
    '<p style="font-size:14px;line-height:1.7;color:var(--ink2);">另一台设备正在请求登录你的账号。<br>确认是你本人在操作？</p>' +
    '<button class="btn primary block" id="qr-yes" style="margin-top:16px;">确认授权登录</button>' +
    '<p class="auth-foot" style="font-size:12px;color:var(--mut);margin-top:12px;text-align:center;">不是你操作的请忽略本页(票据 2 分钟后自动失效)</p>' +
    '</div></div></div>';
  $('#qr-yes').onclick = async () => {
    try {
      await API.post('/api/auth/qr/approve', { ticket });
      $('#qr-approve-body').innerHTML = '<p style="font-size:15px;font-weight:700;color:var(--brand);text-align:center;margin:18px 0;">✓ 已授权，另一台设备即将自动登录</p><p class="auth-foot" style="text-align:center;"><a href="#/library">返回课件库</a></p>';
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ================================================================
 *  14. 论坛 (viewForum)
 * ================================================================ */
App.forum = { board: 0, thread: 0, page: 1 };

async function viewForum(openTid) {
  document.title = '论坛 - FLA';
  if (openTid) App.forum.thread = openTid;
  $('#app').innerHTML = shell('<div id="forum"></div>', 'forum');
  bindLogout();
  if (App.forum.thread) renderForumThread(App.forum.thread);
  else renderForumList();
}

async function renderForumList() {
  const box = $('#forum');
  if (!box) return;
  App.forum.thread = 0;
  const admin = App.user.role === 'admin';
  let boards = [];
  try { boards = (await API.get('/api/forum/boards')).items; } catch (e) { toast(e.message, 'err'); return; }
  const thUrl = App.forum.board ? ('/api/forum/threads?board=' + App.forum.board) : '/api/forum/threads';
  const th = await API.get(thUrl).catch(() => null);
  const threads = th ? th.items : [];
  const boardName = id => { const b = boards.find(x => x.id === id); return b ? UI.esc(b.name) : '全站'; };

  box.innerHTML =
    '<div class="lib-head" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">' +
      '<h2>教学论坛与交流</h2>' +
      '<div class="lib-actions" style="display:flex;gap:10px;">' +
        '<select id="fb-sel" class="inp" style="width:auto;margin:0;">' +
          '<option value="0">全部板块</option>' + boards.map(b => '<option value="' + b.id + '"' + (App.forum.board === b.id ? ' selected' : '') + '>' + UI.esc(b.name) + '</option>').join('') +
        '</select>' +
        '<button class="btn primary" id="fb-new">' + UI.icon('plus', 15) + ' 发布新帖</button>' +
        (admin ? '<button class="btn ghost" id="fb-boards">板块管理</button>' : '') +
      '</div>' +
    '</div>' +
    '<div class="forum-boards" style="display:flex;gap:10px;margin-bottom:20px;overflow-x:auto;">' + boards.map(b =>
      '<button class="filter-pill' + (App.forum.board === b.id ? ' active' : '') + '" data-b="' + b.id + '"><b>' + UI.esc(b.name) + '</b> <span style="opacity:0.75;font-size:12px;">(' + b.threads + ')</span></button>').join('') +
    '</div>' +
    (threads.length ? '<div class="files-table-wrap"><table class="files-table"><thead><tr><th>主题</th><th style="width:120px">作者</th><th style="width:70px">回复</th><th style="width:140px">最后活动</th></tr></thead><tbody>' +
      threads.map(t =>
        '<tr><td><a class="ft-title" href="#/forum/' + t.id + '" style="font-weight:600;font-size:14.5px;">' + (t.pinned ? '<span style="color:var(--brand);margin-right:4px;">' + UI.icon('pin', 12) + '</span>' : '') + UI.esc(t.title) + (t.locked ? ' <span style="color:var(--mut);font-size:11.5px;">' + UI.icon('lock', 11) + '已锁</span>' : '') + '</a><br><span class="muted" style="font-size:12px;">' + boardName(t.board_id) + '</span></td>' +
        '<td><span style="display:inline-flex;align-items:center;gap:6px;">' + avatarHTML(t.author, 24) + ' ' + UI.esc(t.author.nickname) + certHTML(t.author) + '</span></td>' +
        '<td>' + t.replies + '</td><td class="muted">' + UI.fmtDate(t.last_reply_at) + '</td></tr>').join('') +
      '</tbody></table></div>' : '<div class="empty">' + UI.icon('forum', 38) + '<p style="margin-top:12px;">还没有帖子，点击右上角「发布新帖」开始交流</p></div>');

  $('#fb-sel').onchange = e => { App.forum.board = parseInt(e.target.value, 10); renderForumList(); };
  $$('.filter-pill[data-b]', box).forEach(b => b.onclick = () => {
    App.forum.board = App.forum.board === +b.dataset.b ? 0 : +b.dataset.b;
    renderForumList();
  });
  $('#fb-new').onclick = () => forumComposer(boards);
  const bm = $('#fb-boards');
  if (bm) bm.onclick = () => forumBoardsAdmin(boards);
}

function forumComposer(boards) {
  const m = UI.modal({ title: '发布新帖',
    body: '<label>板块<select id="fc-board">' + boards.map(b => '<option value="' + b.id + '">' + UI.esc(b.name) + '</option>').join('') + '</select></label>' +
    '<label>标题<input id="fc-title" maxlength="100" placeholder="简短清晰的标题"></label>' +
    '<label>内容<textarea id="fc-content" rows="6" placeholder="支持写下您的教学心得、课件建议或提问…"></textarea></label>' });
  m.foot.innerHTML = '<button class="btn" id="fc-cancel">取消</button><button class="btn primary" id="fc-ok">发布</button>';
  m.foot.querySelector('#fc-cancel').onclick = m.close;
  m.foot.querySelector('#fc-ok').onclick = async () => {
    try {
      const r = await API.post('/api/forum/threads', {
        board_id: +$('#fc-board').value, title: $('#fc-title').value, content: $('#fc-content').value
      });
      m.close();
      App.forum.thread = r.id;
      renderForumThread(r.id);
    } catch (e) { toast(e.message, 'err'); }
  };
}

async function renderForumThread(tid) {
  const box = $('#forum');
  if (!box) return;
  let t;
  try { t = await API.get('/api/forum/threads/' + tid); } catch (e) { toast(e.message, 'err'); App.forum.thread = 0; renderForumList(); return; }
  const admin = App.user.role === 'admin';
  const mine = t.mine || admin;
  box.innerHTML =
    '<div class="lib-head" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">' +
      '<h2>论坛帖子</h2>' +
      '<button class="btn ghost" id="ft-back">' + UI.icon('back', 14) + ' 返回帖子列表</button>' +
    '</div>' +
    '<div class="card ft-main" style="padding:24px;border-radius:16px;background:#fff;border:1px solid var(--line);margin-bottom:20px;box-shadow:var(--shadow-sm);">' +
      '<div class="ft-head" style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;">' +
        '<div>' +
          '<h3 style="font-size:20px;margin-bottom:6px;">' + (t.pinned ? '<span style="color:var(--brand);margin-right:6px;">' + UI.icon('pin', 16) + '</span>' : '') + UI.esc(t.title) + '</h3>' +
          '<div class="muted ft-meta" style="display:flex;align-items:center;gap:8px;font-size:13px;">' +
            avatarHTML(t.author, 22) + ' <b>' + UI.esc(t.author.nickname) + '</b>' + certHTML(t.author) + ' · ' + UI.fmtDate(t.created_at) +
            (t.locked ? ' · <b style="color:var(--danger)">已锁定</b>' : '') +
          '</div>' +
        '</div>' +
        (mine ? '<div class="ft-ops" style="display:flex;gap:6px;">' +
          (admin ? '<button class="btn xs ghost" id="ft-pin">' + (t.pinned ? '取消置顶' : '置顶') + '</button><button class="btn xs ghost" id="ft-lock">' + (t.locked ? '解锁' : '锁定') + '</button>' : '') +
          '<button class="btn xs ghost" id="ft-edit">编辑</button>' +
          '<button class="btn xs danger" id="ft-del">删除</button></div>' : '') +
      '</div>' +
      '<div class="ft-content" style="font-size:14.5px;line-height:1.7;color:var(--ink2);">' + UI.esc(t.content).replace(/\n/g, '<br>') + '</div>' +
    '</div>' +

    '<h4 style="font-size:16px;margin-bottom:14px;">回复讨论 (' + t.total + ')</h4>' +
    (t.posts.map(p =>
      '<div class="card ft-post" data-id="' + p.id + '" style="padding:16px 20px;border-radius:12px;background:#fff;border:1px solid var(--line);margin-bottom:12px;">' +
      '<div class="ft-meta" style="display:flex;justify-content:space-between;margin-bottom:8px;font-size:13px;">' +
        '<div style="display:flex;align-items:center;gap:6px;">' + avatarHTML(p.author, 24) + '<b>' + UI.esc(p.author.nickname) + '</b>' + certHTML(p.author) +
        '<span class="muted"> · ' + UI.fmtDate(p.created_at) + (p.edited ? ' · 已编辑' + (p.edited_by_admin ? '(管理员)' : '') : '') + '</span></div>' +
        ((p.mine || admin) ? '<span class="ft-post-ops" style="display:flex;gap:6px;"><button class="btn xs ghost" data-op="edit">编辑</button><button class="btn xs danger" data-op="del">删除</button></span>' : '') +
      '</div>' +
      '<div class="ft-content" style="font-size:14px;line-height:1.6;color:var(--ink2);">' + UI.esc(p.content).replace(/\n/g, '<br>') + '</div></div>').join('') || '<div class="empty">还没有人回复，来抢个沙发吧</div>') +
    (t.locked && !admin ? '<div class="card" style="text-align:center;padding:18px;color:var(--mut);">该主题已锁定，暂不支持回复</div>' :
      '<div class="card ft-reply" style="padding:20px;border-radius:14px;background:#fff;border:1px solid var(--line);margin-top:20px;">' +
      '<textarea id="ft-reply-txt" rows="3" placeholder="' + (t.locked ? '主题已锁定(管理员仍可回复)' : '写下你的回复与思考…') + '"></textarea>' +
      '<button class="btn primary" id="ft-reply-ok" style="margin-top:12px;">' + UI.icon('send', 14) + ' 提交回复</button></div>');

  $('#ft-back').onclick = () => { App.forum.thread = 0; renderForumList(); };
  const reply = async () => {
    const c = $('#ft-reply-txt').value.trim();
    if (!c) return;
    try { await API.post('/api/forum/threads/' + tid + '/posts', { content: c }); renderForumThread(tid); }
    catch (e) { toast(e.message, 'err'); }
  };
  if ($('#ft-reply-ok')) $('#ft-reply-ok').onclick = reply;
  $$('.ft-post .ft-post-ops button', box).forEach(b => b.onclick = async () => {
    const pid = +b.closest('.ft-post').dataset.id;
    if (b.dataset.op === 'del') {
      const ok = await UI.confirm('确定删除这条回复？');
      if (!ok) return;
      try { await API.del('/api/forum/posts/' + pid); renderForumThread(tid); } catch (e) { toast(e.message, 'err'); }
    } else {
      const p = t.posts.find(x => x.id === pid);
      const m = UI.modal({ title: '编辑回复', body: '<textarea id="ep-txt" rows="5">' + UI.esc(p.content) + '</textarea>' });
      m.foot.innerHTML = '<button class="btn" id="ep-c">取消</button><button class="btn primary" id="ep-ok">保存</button>';
      m.foot.querySelector('#ep-c').onclick = m.close;
      m.foot.querySelector('#ep-ok').onclick = async () => {
        try { await API.patch('/api/forum/posts/' + pid, { content: $('#ep-txt').value }); m.close(); renderForumThread(tid); }
        catch (e) { toast(e.message, 'err'); }
      };
    }
  });
  const pinB = $('#ft-pin');
  if (pinB) pinB.onclick = async () => { try { await API.patch('/api/forum/threads/' + tid, { pinned: !t.pinned }); renderForumThread(tid); } catch (e) { toast(e.message, 'err'); } };
  const lockB = $('#ft-lock');
  if (lockB) lockB.onclick = async () => { try { await API.patch('/api/forum/threads/' + tid, { locked: !t.locked }); renderForumThread(tid); } catch (e) { toast(e.message, 'err'); } };
  const delB = $('#ft-del');
  if (delB) delB.onclick = async () => {
    const ok = await UI.confirm('确定删除整个帖子(含所有回复)？删除后无法恢复');
    if (!ok) return;
    try { await API.del('/api/forum/threads/' + tid); App.forum.thread = 0; renderForumList(); } catch (e) { toast(e.message, 'err'); }
  };
  const editB = $('#ft-edit');
  if (editB) editB.onclick = () => {
    const m = UI.modal({ title: '编辑帖子',
      body: '<label>标题<input id="et-title" value="' + UI.esc(t.title) + '"></label>' +
      '<label>内容<textarea id="et-content" rows="7">' + UI.esc(t.content) + '</textarea></label>' });
    m.foot.innerHTML = '<button class="btn" id="et-c">取消</button><button class="btn primary" id="et-ok">保存</button>';
    m.foot.querySelector('#et-c').onclick = m.close;
    m.foot.querySelector('#et-ok').onclick = async () => {
      try {
        await API.patch('/api/forum/threads/' + tid, { title: $('#et-title').value, content: $('#et-content').value });
        m.close(); renderForumThread(tid);
      } catch (e) { toast(e.message, 'err'); }
    };
  };
}

function forumBoardsAdmin(boards) {
  const m = UI.modal({ title: '板块管理',
    body: '<div class="boards-admin">' + boards.map(b =>
      '<div class="board-row" data-id="' + b.id + '" style="display:flex;gap:8px;margin-bottom:8px;"><input value="' + UI.esc(b.name) + '" data-f="name" maxlength="30">' +
      '<input value="' + UI.esc(b.descr) + '" data-f="descr" maxlength="100">' +
      '<button class="btn xs" data-op="save">保存</button><button class="btn xs danger" data-op="del">删除</button></div>').join('') +
    '</div>' +
    '<div class="board-row" style="display:flex;gap:8px;margin-top:14px;"><input id="nb-name" placeholder="新板块名" maxlength="30">' +
    '<input id="nb-descr" placeholder="描述(可选)" maxlength="100"><button class="btn xs primary" id="nb-add">添加板块</button></div>' });
  $$('.board-row [data-op]', m.body).forEach(b => b.onclick = async () => {
    const row = b.closest('.board-row'), id = +row.dataset.id;
    if (b.dataset.op === 'del') {
      const ok = await UI.confirm('确定删除板块(含其中所有帖子)？');
      if (!ok) return;
      try { await API.del('/api/admin/forum/boards/' + id); m.close(); renderForumList(); } catch (e) { toast(e.message, 'err'); }
    } else {
      try {
        await API.patch('/api/admin/forum/boards/' + id, {
          name: row.querySelector('[data-f=name]').value, descr: row.querySelector('[data-f=descr]').value
        });
        toast('已保存', 'ok'); m.close(); renderForumList();
      } catch (e) { toast(e.message, 'err'); }
    }
  });
  m.body.querySelector('#nb-add').onclick = async () => {
    try { await API.post('/api/admin/forum/boards', { name: $('#nb-name').value, descr: $('#nb-descr').value }); m.close(); renderForumList(); }
    catch (e) { toast(e.message, 'err'); }
  };
}

window.openChatDM = function (uid) { if (window.Chat) Chat.openDM(uid); };

document.addEventListener('click', e => {
  if (e.target.closest('#top-ann')) { openAnnPanel(); return; }
  if (e.target.closest('#top-qr')) { openScanModal(); return; }
});
