/* FLA - 前端主应用: 路由 / 登录注册 / 课件库 / 个人中心 */
'use strict';
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const toast = (m, t) => UI.toast(m, t);

window.App = { user: null, setCleanup(fn) { App._cleanup = fn; } };
let _cleanup = null;
let pollT = null;

const ACCEPT = '.ppt,.pptx,.pps,.ppsx,.pot,.potx,.doc,.docx,.dot,.dotx,.rtf,.xls,.xlsx,.csv,.txt,.odt,.ods,.odp,.wps,.et,.dps,.pdf,.png,.jpg,.jpeg,.webp,.gif,.bmp,.svg,.mp3,.wav,.ogg,.m4a,.aac,.flac,.mp4,.webm,.mkv,.mov,.m4v';

document.addEventListener('DOMContentLoaded', async () => {
  window.addEventListener('hashchange', route);
  if (API.token) {
    try { App.user = await API.get('/api/auth/me'); } catch (e) { /* token 失效 */ }
  }
  if (window.Chat && App.user) Chat.startBadge();   /* v1.27: 全局聊天未读角标 */
  route();
});

function runCleanup() {
  if (_cleanup) { try { _cleanup(); } catch (e) { } _cleanup = null; }
  if (pollT) { clearInterval(pollT); pollT = null; }
}
App.runCleanup = runCleanup;

function route() {
  runCleanup();
  const path = (location.hash || '#/library').replace(/^#\//, '').split('?')[0];
  const parts = path.split('/').filter(Boolean);
  if (!App.user) {
    if (parts[0] === 'register') return viewRegister();
    return viewLogin();
  }
  if (parts[0] === 'login' || parts[0] === 'register') { location.hash = '#/library'; return; }
  refreshAnnBadge();   /* v1.26: 公告未读红点 */
  if (window.Chat) Chat.refreshBadge();   /* v1.27: 聊天未读角标 */
  if (!parts.length || parts[0] === 'library') return viewLibrary();
  if (parts[0] === 'profile') return viewProfile();
  if (parts[0] === 'forum') return viewForum(parts[1] ? parseInt(parts[1], 10) : 0);
  if (parts[0] === 'chat') return Chat.view();   /* v1.27: 微信级聊天(web/js/chat.js) */
  if (parts[0] === 'qr-approve') return viewQrApprove();
  if (parts[0] === 'admin') {
    if (App.user.role !== 'admin') { toast('需要管理员权限', 'err'); location.hash = '#/library'; return; }
    return Admin.view();
  }
  if (parts[0] === 'view' && parts[1] && window.Viewer) { Viewer.open(parseInt(parts[1], 10)); refreshAnnBadge(); return; }
  location.hash = '#/library';
}

/* ---------- 通用 ---------- */
function avatarHTML(u, size) {
  size = size || 34;
  const st = 'width:' + size + 'px;height:' + size + 'px';
  if (u && u.avatar) return '<img class="avatar" style="' + st + '" src="' + UI.esc(u.avatar) + '">';
  const c = UI.esc(((u && u.nickname) || 'U').slice(0, 1).toUpperCase());
  return '<span class="avatar avatar-ph" style="' + st + ';font-size:' + Math.round(size * .45) + 'px">' + c + '</span>';
}

/* v1.26: 认证徽章 — 站长(铂金皇冠) + 教师(管理员自定义图标/颜色) */
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

/* hex → rgba 串(CSS 渐变/光环用) */
function hexA(hex, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return 'rgba(240,212,136,' + a + ')';
  const n = parseInt(m[1], 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

/* ================================================================
 * v1.27 认证证书 — 站长(铂金极光) / 教师(黄金·白银·青铜·定制)
 * 比 v1.26 更"nb"的地方:
 *   1. 鼠标跟随 3D 倾斜 + 分层视差(奖章浮得比证书高)
 *   2. 全息箔层: 随倾斜角度流动变色(真证书上的那种彩虹膜)
 *   3. 雕刻底纹(guilloché) + 旋转光束 + 极光 + 星芒 + 扫光
 *   4. 正式证书要素: 等级条 / 编号 / 签发日期 / 授权范围 / 校验码 /
 *      二维码(扫码即校验串) / 骑缝章 / 绶带
 *   5. 「查看大图」全屏展示, 「打印证书」用打印样式只印证书(可存 PDF)
 * 校验码由 id + 角色 + 称号 + 签发日 FNV-1a 哈希得出, 同一账号永远一致。
 * ================================================================ */
function certCode(u) {
  const raw = 'FLA|' + (u.id || 0) + '|' + (u.role || '') + '|' + (u.is_teacher ? 1 : 0) + '|' +
    (u.cert_title || '') + '|' + String(u.created_at || '').slice(0, 10);
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) { h ^= raw.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  const s36 = (h.toString(36).toUpperCase() + '000000').slice(0, 6);
  return s36.slice(0, 3) + '-' + s36.slice(3);
}

/* 颜色 → 等级名(铂金/黄金/白银/青铜/定制) */
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
  const sparks = spark(9, 18, 0, 13) + spark(88, 13, 1.1, 10) + spark(80, 62, 2.2, 14) + spark(13, 68, .6, 10) +
    spark(51, 6, 1.7, 9) + spark(30, 88, 2.8, 12) + spark(92, 84, .3, 11) + spark(66, 33, 1.4, 8);
  let h = '';

  /* ---------- 站长: 铂金极光(最高级) ---------- */
  if (u.role === 'admin') {
    h += '<div class="cert-card tier-platinum" data-cert="owner" data-no="' + no + '" data-code="' + code + '"' +
      ' data-title="站长" data-en="FLA · SITE OWNER" data-since="' + since + '" data-tier="' + tier.en + '">' +
      '<i class="cc-guilloche"></i><i class="cc-aurora"></i><i class="cc-beam"></i><i class="cc-holo"></i>' +
      '<i class="cc-sheen"></i>' + sparks +
      '<i class="cc-corner tl"></i><i class="cc-corner tr"></i><i class="cc-corner bl"></i><i class="cc-corner br"></i>' +
      '<i class="cc-ribbon"></i>' +
      '<div class="cc-inner">' +
      '<div class="cc-tier">' + UI.icon('gem', 12) + '<span>' + tier.en + ' · ' + tier.zh + '级</span></div>' +
      '<div class="cc-medal">' + UI.icon('crown', 46) +
      '<i class="cc-ring r1"></i><i class="cc-ring r2"></i><i class="cc-ring r3"></i><i class="cc-halo"></i></div>' +
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
  }

  /* ---------- 教师: 图标与颜色由管理员自定义 ---------- */
  if (u.is_teacher) {
    const icon = CERT_ICON_LIST.includes(u.cert_icon) ? u.cert_icon : 'medal';
    const color = /^#[0-9a-fA-F]{6}$/.test(u.cert_color || '') ? u.cert_color : '#f0d488';
    const title = u.cert_title || '认证教师';
    h += '<div class="cert-card tier-' + tier.k + '" data-cert="teacher" data-no="' + no + '" data-code="' + code + '"' +
      ' data-title="' + UI.esc(title) + '" data-en="FLA · CERTIFIED EDUCATOR" data-since="' + since + '"' +
      ' data-tier="' + tier.en + '"' +
      ' style="--cc:' + color + ';--cc-soft:' + hexA(color, .55) + ';--cc-faint:' + hexA(color, .16) +
      ';--cc-line:' + hexA(color, .34) + '">' +
      '<i class="cc-guilloche"></i><i class="cc-holo"></i><i class="cc-sheen"></i>' + sparks +
      '<i class="cc-corner tl"></i><i class="cc-corner tr"></i><i class="cc-corner bl"></i><i class="cc-corner br"></i>' +
      '<div class="cc-inner">' +
      '<div class="cc-tier">' + UI.icon('medal', 12) + '<span>' + tier.en + ' · ' + tier.zh + '级</span></div>' +
      '<div class="cc-medal">' + UI.icon(icon, 48) +
      '<i class="cc-ring r1"></i><i class="cc-ring r2"></i><i class="cc-halo"></i></div>' +
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
  }

  /* ---------- 未认证占位 ---------- */
  if (!u.is_teacher && u.role !== 'admin') {
    h += '<div class="cert-card pending">' +
      '<div class="cc-medal">' + UI.icon('lock', 28) + '</div>' +
      '<div class="cc-title">教师认证</div>' +
      '<div class="cc-sub">FLA · CERTIFIED EDUCATOR</div>' +
      '<p class="cc-note">未完成教师认证（不影响任何功能使用，认证后展示专属称号与证书）</p>' +
      '</div>';
  }
  return h;
}

/* 证书交互: 3D 倾斜 + 视差 + 全息 + 二维码 + 大图 + 打印 */
function bindCertCards(root) {
  const cards = $$('.cert-card:not(.pending)', root || document);
  cards.forEach(card => {
    /* --- 鼠标跟随倾斜(只用 transform, 不触发重排) --- */
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
    /* --- 二维码(懒加载组件, 失败也不影响证书展示) --- */
    const qr = $('.cc-qr', card);
    if (qr && !qr.dataset.done) {
      qr.dataset.done = '1';
      const txt = 'FLA CERTIFICATE\n' +
        'NO. ' + card.dataset.no + '\n' +
        card.dataset.title + ' / ' + card.dataset.en + '\n' +
        'TIER ' + card.dataset.tier + '\n' +
        'SINCE ' + card.dataset.since + '\n' +
        'VERIFY ' + card.dataset.code + '\n' +
        location.origin;
      loadScript('/lib/qrcode/qrcode.min.js').then(() => {
        if (!window.QRCode) throw new Error('no lib');
        qr.innerHTML = '';
        new window.QRCode(qr, {
          text: txt, width: 62, height: 62,
          colorDark: '#0b0c0f', colorLight: '#ffffff',
          correctLevel: window.QRCode.CorrectLevel.M
        });
        const img = qr.querySelector('canvas, img');
        if (img) { img.style.width = '62px'; img.style.height = '62px'; img.style.borderRadius = '6px'; }
      }).catch(() => { qr.innerHTML = '<em class="cc-qr-fail">' + card.dataset.code + '</em>'; });
    }
    /* --- 大图 / 打印 --- */
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
  setTimeout(() => {
    window.print();
    setTimeout(done, 1500);      /* 某些浏览器不触发 afterprint */
  }, 260);
}
window.certCardHTML = certCardHTML;
window.bindCertCards = bindCertCards;

function bindLogout() {
  const b = $('#logout');
  if (b) b.onclick = () => { API.setToken(''); App.user = null; location.hash = '#/login'; };
}
window.bindLogout = bindLogout;

function shell(content, active) {
  const u = App.user;
  return '<div class="topbar">' +
    '<div class="brand">' + UI.icon('board', 26) + '<span>FLA</span></div>' +
    '<nav class="nav">' +
    '<a class="' + (active === 'library' ? 'on' : '') + '" href="#/library">我的课件</a>' +
    '<a class="' + (active === 'forum' ? 'on' : '') + '" href="#/forum">' + UI.icon('forum', 15) + ' 论坛</a>' +
    '<a class="' + (active === 'chat' ? 'on' : '') + '" href="#/chat">' + UI.icon('chat', 15) +
    ' 聊天<i class="nav-badge hidden" id="chat-badge"></i></a>' +
    '<a class="' + (active === 'profile' ? 'on' : '') + '" href="#/profile">个人中心</a>' +
    (u.role === 'admin' ? '<a class="' + (active === 'admin' ? 'on' : '') + '" href="#/admin">管理后台</a>' : '') +
    '</nav>' +
    '<div class="top-right">' + certHTML(u) +
    '<button class="icon-btn" id="top-ann" title="公告"><i class="ann-dot hidden" id="ann-dot"></i>' + UI.icon('horn', 18) + '</button>' +
    '<button class="icon-btn" id="top-qr" title="扫码登录其他设备">' + UI.icon('qr', 18) + '</button>' +
    '<span class="uchip">' + avatarHTML(u, 32) + '<b>' + UI.esc(u.nickname) + '</b></span>' +
    '<button class="btn sm ghost" id="logout" title="退出登录">' + UI.icon('logout', 16) + '</button>' +
    '</div></div><div class="page">' + content + '</div>';
}

/* ---------- 登录 / 注册 ---------- */
function viewLogin() {
  document.title = '登录 - FLA';
  const regLink = '<p class="auth-foot">还没有账号？<a href="#/register">使用邀请码注册</a></p>';
  $('#app').innerHTML =
    '<div class="auth-bg"><div class="auth-card">' +
    '<div class="auth-logo">' + UI.icon('board', 36) + '</div>' +
    '<h1>FLA</h1><p class="sub">教学课件与互动白板系统</p>' +
    '<div class="auth-tabs"><button class="on" id="lt-pw">密码登录</button><button id="lt-qr">' + UI.icon('qr', 14) + ' 扫码登录</button></div>' +
    '<form id="f">' +
    '<label>用户名<input name="username" autocomplete="username" required></label>' +
    '<label>密码<input name="password" type="password" autocomplete="current-password" required></label>' +
    '<button class="btn primary block" type="submit">登 录</button></form>' +
    '<div id="qrbox" class="qr-login hidden">' +
    '<div class="qr-holder" id="qr-holder"><div class="qr-spin"></div></div>' +
    '<p class="qr-tip">用<b>已登录 FLA 的设备</b>扫码授权登录</p>' +
    '<p class="qr-tip muted">登录页二维码每 2 分钟自动刷新</p>' +
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
  /* v1.26: 扫码登录 — 显示二维码 + 轮询授权状态 */
  const switchTab = qr => {
    $('#lt-pw').classList.toggle('on', !qr);
    $('#lt-qr').classList.toggle('on', qr);
    $('#f').classList.toggle('hidden', qr);
    $('#qrbox').classList.toggle('hidden', !qr);
    if (qr) startQrLogin(); else stopQrLogin();
  };
  $('#lt-pw').onclick = () => switchTab(false);
  $('#lt-qr').onclick = () => switchTab(true);

  let qrTimers = [];
  function stopQrLogin() { qrTimers.forEach(t => clearInterval(t) || clearTimeout(t)); qrTimers = []; }
  async function startQrLogin() {
    stopQrLogin();
    try { await loadScript('/lib/qrcode/qrcode.min.js'); } catch (e) { toast('二维码组件加载失败', 'err'); return; }
    const holder = $('#qr-holder');
    holder.innerHTML = '<div class="qr-spin"></div>';
    let ticket = '';
    const refresh = async () => {
      try {
        const r = await API.post('/api/auth/qr/ticket');
        ticket = r.ticket;
        const url = location.origin + '/#/qr-approve?ticket=' + encodeURIComponent(ticket);
        holder.innerHTML = '';
        new window.QRCode(holder, { text: url, width: 190, height: 190, correctLevel: window.QRCode.CorrectLevel.M });
      } catch (e) { toast(e.message, 'err'); }
    };
    refresh();
    qrTimers.push(setInterval(refresh, 110 * 1000));                       // 票据 150s, 110s 换新
    qrTimers.push(setInterval(async () => {                                // 1.5s 轮询
      if (!ticket) return;
      try {
        const s = await API.get('/api/auth/qr/status?ticket=' + encodeURIComponent(ticket));
        if (s.status === 'ok' && s.token) {
          stopQrLogin();
          API.setToken(s.token); App.user = s.user;
          toast('扫码登录成功');
          afterLoginGo();
        } else if (s.status === 'expired' || s.status === 'invalid') {
          refresh();
        }
      } catch (e) { /* 网络抖动忽略 */ }
    }, 1500));
    App.setCleanup(stopQrLogin);
  }
}

/* 登录后跳转: 优先回到扫码授权前的页面 */
function afterLoginGo() {
  let back = '';
  try { back = sessionStorage.getItem('fla_after_login') || ''; sessionStorage.removeItem('fla_after_login'); } catch (e) { }
  location.hash = back || '#/library';
}

async function viewRegister() {
  document.title = '注册 - FLA';
  let open = true;
  try { open = (await API.get('/api/auth/config')).registration_open; } catch (e) { }
  if (!open) {
    $('#app').innerHTML = '<div class="auth-bg"><div class="auth-card"><h1>注册已关闭</h1><p class="sub">请联系管理员</p><p class="auth-foot"><a href="#/login">返回登录</a></p></div></div>';
    return;
  }
  $('#app').innerHTML =
    '<div class="auth-bg"><div class="auth-card">' +
    '<div class="auth-logo">' + UI.icon('board', 36) + '</div>' +
    '<h1>注册账号</h1><p class="sub">需要邀请码（向管理员索取）</p>' +
    '<form id="f">' +
    '<label>邀请码<input name="invite_code" placeholder="例如 ABCD-EFGH-JKLM" required></label>' +
    '<label>用户名<input name="username" autocomplete="username" required></label>' +
    '<label>昵称（可选）<input name="nickname" maxlength="32"></label>' +
    '<label>密码<input name="password" type="password" minlength="6" required></label>' +
    '<label>确认密码<input name="password2" type="password" minlength="6" required></label>' +
    '<button class="btn primary block" type="submit">注 册</button></form>' +
    '<p class="auth-foot">已有账号？<a href="#/login">返回登录</a></p>' +
    '</div></div>';
  $('#f').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (fd.get('password') !== fd.get('password2')) { toast('两次输入的密码不一致', 'err'); return; }
    try {
      const r = await API.post('/api/auth/register', {
        invite_code: String(fd.get('invite_code')).trim(),
        username: String(fd.get('username')).trim(),
        nickname: String(fd.get('nickname') || '').trim(),
        password: String(fd.get('password')),
      });
      API.setToken(r.token); App.user = r.user;
      toast('注册成功，欢迎加入！');
      location.hash = '#/library';
    } catch (err) { toast(err.message, 'err'); }
  };
}

/* ---------- 课件库 ---------- */
function kindBadge(f) {
  if (f.kind === 'board') return '<span class="kbadge board">白板</span>';
  const ext = (f.ext || '').toUpperCase();
  const label = ext ? ext.slice(0, 5) : 'FILE';
  return '<span class="kbadge">' + UI.esc(label) + '</span>';
}

function cardHTML(f) {
  const st = f.status === 'converting' ? '<span class="st converting">转换中…</span>'
    : f.status === 'failed' ? '<span class="st failed">转换失败</span>' : '';
  return '<div class="file-card" data-id="' + f.id + '">' +
    '<div class="fc-top">' + kindBadge(f) + st + '</div>' +
    '<div class="fc-name" title="' + UI.esc(f.name) + '">' + UI.esc(f.name) + '</div>' +
    '<div class="fc-meta">' + (f.kind === 'board' ? '无限画布' : UI.fmtSize(f.size)) + ' · ' + UI.fmtDate(f.created_at) +
    (f.kind !== 'board' && f.pages ? ' · ' + f.pages + ' 页' : '') + '</div>' +
    '<div class="act">' +
    '<button data-a="open" title="打开">' + UI.icon('board', 16) + ' 打开</button>' +
    (f.kind === 'board' ? '' : '<button data-a="dl" title="下载">' + UI.icon('download', 16) + '</button>') +
    (f.kind === 'board' ? '' : '<button data-a="link" title="复制公开直链">' + UI.icon('link', 16) + '</button>') +
    (f.status === 'failed' ? '<button data-a="retry" title="重试转换">' + UI.icon('refresh', 16) + '</button>' : '') +
    '<button data-a="del" title="删除" class="danger">' + UI.icon('trash', 16) + '</button>' +
    '</div></div>';
}

async function viewLibrary() {
  document.title = '我的课件 - FLA';
  $('#app').innerHTML = shell(
    '<div class="lib-head"><div><h2>我的课件</h2><div class="storage" id="storage"></div></div>' +
    '<div class="lib-actions"><button class="btn" id="newboard">' + UI.icon('edit', 16) + ' 新建白板</button>' +
    '<button class="btn primary" id="upbtn">' + UI.icon('upload', 18) + ' 上传课件</button>' +
    '<input type="file" id="upinput" multiple hidden accept="' + ACCEPT + '"></div></div>' +
    '<div class="dropzone" id="dropzone">或将文件拖到这里 · 支持 Office / PDF / 图片 / 音频 / 视频</div>' +
    '<div class="files-grid" id="grid"><div class="empty">加载中…</div></div>' +
    '<div class="uplist" id="uplist"></div>', 'library');
  bindLogout();
  refreshMe();
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
  dz.ondragover = e => { e.preventDefault(); dz.classList.add('over'); };
  dz.ondragleave = () => dz.classList.remove('over');
  dz.ondrop = e => { e.preventDefault(); dz.classList.remove('over'); uploadFiles(Array.from(e.dataTransfer.files)); };
}

async function refreshMe() {
  try { App.user = await API.get('/api/auth/me'); renderStorage(); } catch (e) { }
}

function renderStorage() {
  const el = $('#storage'); if (!el) return;
  const u = App.user;
  const pct = Math.min(100, Math.round(u.used_bytes / u.quota_bytes * 100));
  el.innerHTML = '<div class="sbar"><i style="width:' + pct + '%"></i></div><span>' +
    UI.fmtSize(u.used_bytes) + ' / ' + UI.fmtSize(u.quota_bytes) + '</span>';
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
  const grid = $('#grid');
  if (!grid) return;
  if (!files.length) {
    grid.innerHTML = '<div class="empty">' + UI.icon('file', 42) + '<p>还没有课件，点击右上角「上传课件」开始</p></div>';
    return;
  }
  grid.innerHTML = files.map(cardHTML).join('');
  $$('.file-card', grid).forEach(el => {
    const f = files.find(x => x.id === +el.dataset.id);
    el.onclick = () => openFile(f);
    $$('.act button', el).forEach(b => {
      b.onclick = e => {
        e.stopPropagation();
        const a = b.dataset.a;
        if (a === 'open') openFile(f);
        if (a === 'dl') window.open('/api/files/' + f.id + '/download?token=' + API.token, '_blank');
        if (a === 'link') {
          API.get('/api/files/' + f.id + '/share-link').then(r => {
            const direct = r.direct || (location.origin + r.path);
            copyText(direct).then(() => toast('直链已复制: ' + direct)).catch(() => toast(direct));
          }).catch(err => toast(err.message, 'err'));
        }
        if (a === 'retry') API.post('/api/files/' + f.id + '/retry').then(() => { toast('已重新开始转换'); refreshList(); }).catch(err => toast(err.message, 'err'));
        if (a === 'del') UI.confirm('确定删除《' + UI.esc(f.name) + '》？删除后无法恢复').then(ok => {
          if (!ok) return;
          API.del('/api/files/' + f.id).then(() => { toast('已删除'); refreshList(); refreshMe(); })
            .catch(err => toast(err.message, 'err'));
        });
      };
    });
  });
  if (pollT) { clearInterval(pollT); pollT = null; }
  if (files.some(f => f.status === 'converting')) {
    pollT = setInterval(async () => {
      if (!$('#grid')) { clearInterval(pollT); pollT = null; return; }
      refreshList();
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

/* ---------- 个人中心 ---------- */
async function viewProfile() {
  document.title = '个人中心 - FLA';
  try { App.user = await API.get('/api/auth/me'); } catch (e) { return; }
  const u = App.user;
  $('#app').innerHTML = shell(
    (u.must_change_password ? '<div class="warnbar">⚠ 当前使用初始密码，请尽快修改</div>' : '') +
    '<div class="profile-grid">' +
    '<div class="card p-card"><h3>个人资料</h3>' +
    '<div class="avatar-big" id="avwrap">' + avatarHTML(u, 84) + '</div>' +
    '<div><button class="btn sm" id="avbtn">更换头像</button><input type="file" id="avin" hidden accept="image/png,image/jpeg,image/webp,image/gif"></div>' +
    '<label>昵称<input id="nk" maxlength="32" value="' + UI.esc(u.nickname) + '"></label>' +
    '<label>个性签名<textarea id="sg" maxlength="200" rows="3" placeholder="写点什么介绍自己…">' + UI.esc(u.signature) + '</textarea></label>' +
    certCardHTML(u) +
    '<button class="btn primary" id="savep">保存资料</button></div>' +
    '<div class="card p-card"><h3>账号与安全</h3>' +
    '<div class="kv"><span>用户名</span><b>' + UI.esc(u.username) + '</b></div>' +
    '<div class="kv"><span>角色</span><b>' + (u.role === 'admin' ? '管理员' : '教师用户') + '</b></div>' +
    '<div class="kv"><span>存储空间</span><b>' + UI.fmtSize(u.used_bytes) + ' / ' + UI.fmtSize(u.quota_bytes) + '</b></div>' +
    '<div class="kv"><span>注册时间</span><b>' + UI.fmtDate(u.created_at) + '</b></div>' +
    '<hr><h3>修改密码</h3>' +
    '<label>原密码<input id="pw0" type="password" autocomplete="current-password"></label>' +
    '<label>新密码<input id="pw1" type="password" minlength="6" autocomplete="new-password"></label>' +
    '<label>确认新密码<input id="pw2" type="password" minlength="6" autocomplete="new-password"></label>' +
    '<button class="btn" id="savepw">修改密码</button></div>' +
    '</div>', 'profile');
  bindLogout();
  bindCertCards();   /* v1.27: 证书 3D 倾斜 / 二维码 / 大图 / 打印 */

  $('#avbtn').onclick = () => $('#avin').click();
  $('#avin').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    const form = new FormData(); form.append('file', f, f.name || 'avatar.png');
    try {
      const r = await API.upload('/api/users/avatar', form);
      $('#avwrap').innerHTML = '<img class="avatar" style="width:84px;height:84px" src="' + UI.esc(r.avatar) + '">';
      toast('头像已更新');
    } catch (err) { toast(err.message, 'err'); }
    e.target.value = '';
  };
  $('#savep').onclick = async () => {
    try {
      App.user = await API.put('/api/users/profile', { nickname: $('#nk').value, signature: $('#sg').value });
      toast('已保存');
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#savepw').onclick = async () => {
    const p1 = $('#pw1').value, p2 = $('#pw2').value;
    if (p1 !== p2) { toast('两次输入的新密码不一致', 'err'); return; }
    try {
      await API.post('/api/auth/change_password', { old_password: $('#pw0').value, new_password: p1 });
      toast('密码已修改');
      $('#pw0').value = $('#pw1').value = $('#pw2').value = '';
    } catch (err) { toast(err.message, 'err'); }
  };
}


/* v1.23: 打开课件 = 直接进入放映(白板仍进编辑器) */
function openFile(f) {
  if (f.kind === 'board') { location.hash = '#/view/' + f.id; return; }
  const ext = ((f.name || '').split('.').pop() || '').toLowerCase();
  const ms = f.kind === 'office' && /^(ppt|pptx|doc|docx|xls|xlsx)$/.test(ext);
  window.open('/present.html?fid=' + f.id + '&token=' + encodeURIComponent(API.token) + (ms ? '&track=ms' : ''), '_blank');
}

/* v1.23: 站点背景(管理后台→系统设置) */
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


/* ============================== v1.26 社区: 论坛 / 聊天 / 公告 / 扫码 ============================== */

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector('script[data-fla="' + src + '"]')) return res();
    const s = document.createElement('script');
    s.src = src; s.setAttribute('data-fla', src);
    s.onload = () => res(); s.onerror = () => rej(new Error('组件加载失败'));
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
    '<div class="ann-item ' + a.level + (a.read ? '' : ' unread') + '">' +
    '<div class="ann-head"><b>' + UI.esc(a.title) + '</b>' +
    (a.personal ? '<span class="ann-personal">专属</span>' : '') +
    '<span class="ann-lv ' + a.level + '">' + (lv[a.level] || '公告') + '</span></div>' +
    (a.content ? '<div class="ann-body">' + UI.esc(a.content).replace(/\n/g, '<br>') + '</div>' : '') +
    '<div class="ann-time">' + UI.fmtDate(a.created_at) + '</div></div>'
  ).join('') : '<div class="empty">暂无公告</div>';
  const m = UI.modal({ title: UI.icon('horn', 18) + ' 公告', body: '<div class="ann-list">' + items + '</div>' });
  const unread = r.items.filter(a => !a.read).map(a => a.id);
  if (unread.length) API.post('/api/announcements/read', { ids: unread }).then(refreshAnnBadge).catch(() => { });
  refreshAnnBadge();
}

/* ---------- 扫码(登录其他设备) ---------- */
async function openScanModal() {
  const m = UI.modal({ title: UI.icon('qr', 18) + ' 扫码登录其他设备',
    body: '<div class="scan-box"><video id="scan-v" playsinline muted></video>' +
    '<div class="scan-tip" id="scan-tip">正在启动相机…</div></div>' +
    '<div class="scan-manual"><span>相机不可用？手动输入票据:</span>' +
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
      toast('已授权该设备登录 ✓'); cleanup(); m.close();
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
    tip.textContent = '相机不可用(' + (location.protocol === 'https:' ? '无摄像头' : '需 HTTPS') + ')。用手机相机扫登录二维码→打开链接→页面内授权，或在下方手动输入票据。';
  }
}

/* ---------- 扫码授权页(手机相机打开二维码链接时) ---------- */
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
    '<div class="auth-bg"><div class="auth-card">' +
    '<div class="auth-logo">' + UI.icon('qr', 36) + '</div>' +
    '<h1 style="font-size:26px;letter-spacing:2px">扫码登录授权</h1>' +
    '<p class="sub">' + UI.esc(App.user.nickname) + ' (' + UI.esc(App.user.username) + ')</p>' +
    '<div id="qr-approve-body">' +
    '<p style="font-size:14px;line-height:1.8">另一台设备正在请求登录你的账号。<br>确认是你本人在操作？</p>' +
    '<button class="btn primary block" id="qr-yes">确认授权登录</button>' +
    '<p class="auth-foot">不是你操作的请忽略本页(票据 2 分钟后自动失效)</p>' +
    '</div></div></div>';
  $('#qr-yes').onclick = async () => {
    try {
      await API.post('/api/auth/qr/approve', { ticket });
      $('#qr-approve-body').innerHTML = '<p style="font-size:15px;font-weight:700">✓ 已授权，另一台设备即将自动登录</p><p class="auth-foot">本页可以关闭了</p>';
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ---------- 论坛 ---------- */
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
  const th = App.forum.board ? (await API.get('/api/forum/threads?board=' + App.forum.board).catch(() => null)) : null;
  const threads = th ? th.items : [];
  const boardName = id => { const b = boards.find(x => x.id === id); return b ? b.name : '全站'; };
  box.innerHTML =
    '<div class="lib-head"><h2>论坛</h2><div class="lib-actions">' +
    '<select id="fb-sel" class="inp" style="width:auto;margin-top:0">' +
    '<option value="0">全站</option>' + boards.map(b => '<option value="' + b.id + '"' + (App.forum.board === b.id ? ' selected' : '') + '>' + UI.esc(b.name) + '</option>').join('') +
    '</select>' +
    '<button class="btn" id="fb-new">' + UI.icon('plus', 15) + ' 发帖</button>' +
    (admin ? '<button class="btn ghost" id="fb-boards">板块管理</button>' : '') +
    '</div></div>' +
    '<div class="forum-boards">' + boards.map(b =>
      '<button class="f-board' + (App.forum.board === b.id ? ' on' : '') + '" data-b="' + b.id + '"><b>' + UI.esc(b.name) + '</b><span>' + b.threads + ' 帖</span><i>' + UI.esc(b.descr) + '</i></button>').join('') +
    '</div>' +
    (threads.length ? '<table class="tbl forum-tbl"><thead><tr><th>主题</th><th style="width:110px">作者</th><th style="width:52px">回复</th><th style="width:132px">最后活动</th></tr></thead><tbody>' +
      threads.map(t =>
        '<tr><td><a class="ft-title" href="#/forum/' + t.id + '">' + (t.pinned ? '<span class="ft-pin">' + UI.icon('pin', 12) + '</span>' : '') + UI.esc(t.title) + (t.locked ? ' <span class="ft-lock">' + UI.icon('lock', 11) + '已锁</span>' : '') + '</a><br><span class="muted">' + boardName(t.board_id) + '</span></td>' +
        '<td><span class="f-author">' + avatarHTML(t.author, 24) + ' ' + UI.esc(t.author.nickname) + certHTML(t.author) + '</span></td>' +
        '<td>' + t.replies + '</td><td class="muted">' + UI.fmtDate(t.last_reply_at) + '</td></tr>').join('') +
      '</tbody></table>' : '<div class="empty">' + UI.icon('forum', 34) + '<br>还没有帖子，来发第一帖</div>');
  $('#fb-sel').onchange = e => { App.forum.board = parseInt(e.target.value, 10); renderForumList(); };
  $$('.f-board', box).forEach(b => b.onclick = () => {
    App.forum.board = App.forum.board === +b.dataset.b ? 0 : +b.dataset.b;
    renderForumList();
  });
  $('#fb-new').onclick = () => forumComposer(boards);
  const bm = $('#fb-boards');
  if (bm) bm.onclick = () => forumBoardsAdmin(boards);
}

function forumComposer(boards) {
  const m = UI.modal({ title: '发帖',
    body: '<label>板块<select id="fc-board">' + boards.map(b => '<option value="' + b.id + '">' + UI.esc(b.name) + '</option>').join('') + '</select></label>' +
    '<label>标题<input id="fc-title" maxlength="100"></label>' +
    '<label>内容<textarea id="fc-content" rows="6"></textarea></label>' });
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
    '<div class="lib-head"><h2>论坛</h2><div class="lib-actions">' +
    '<button class="btn ghost" id="ft-back">' + UI.icon('back', 14) + ' 返回列表</button></div></div>' +
    '<div class="card ft-main">' +
    '<div class="ft-head"><h3>' + (t.pinned ? '<span class="ft-pin">' + UI.icon('pin', 14) + '</span>' : '') + UI.esc(t.title) + '</h3>' +
    '<div class="muted ft-meta">' + avatarHTML(t.author, 22) + ' ' + UI.esc(t.author.nickname) + certHTML(t.author) + ' · ' + UI.fmtDate(t.created_at) +
    (t.locked ? ' · <b class="ft-lock">已锁定</b>' : '') + '</div>' +
    (mine ? '<div class="ft-ops">' +
      (admin ? '<button class="btn xs ghost" id="ft-pin">' + (t.pinned ? '取消置顶' : '置顶') + '</button><button class="btn xs ghost" id="ft-lock">' + (t.locked ? '解锁' : '锁定') + '</button>' : '') +
      '<button class="btn xs ghost" id="ft-edit">编辑</button>' +
      '<button class="btn xs ghost" id="ft-del">删除</button></div>' : '') +
    '</div>' +
    '<div class="ft-content">' + UI.esc(t.content).replace(/\n/g, '<br>') + '</div></div>' +
    '<h4 class="ft-replies-title">回复 (' + t.total + ')</h4>' +
    (t.posts.map(p =>
      '<div class="card ft-post" data-id="' + p.id + '">' +
      '<div class="ft-meta">' + avatarHTML(p.author, 26) + '<b>' + UI.esc(p.author.nickname) + '</b>' + certHTML(p.author) +
      '<span class="muted"> · ' + UI.fmtDate(p.created_at) + (p.edited ? ' · 已编辑' + (p.edited_by_admin ? '(管理员)' : '') : '') + '</span>' +
      ((p.mine || admin) ? '<span class="ft-post-ops"><button class="btn xs ghost" data-op="edit">编辑</button><button class="btn xs ghost" data-op="del">删除</button></span>' : '') +
      '</div><div class="ft-content">' + UI.esc(p.content).replace(/\n/g, '<br>') + '</div></div>').join('') || '<div class="empty">还没有回复</div>') +
    (t.locked && !admin ? '<div class="card" style="text-align:center;padding:18px" class="muted">帖子已锁定</div>' :
      '<div class="card ft-reply"><textarea id="ft-reply-txt" rows="3" placeholder="' + (t.locked ? '帖子已锁定(管理员仍可回复)' : '写下你的回复…') + '"></textarea>' +
      '<button class="btn primary" id="ft-reply-ok" style="margin-top:10px">' + UI.icon('send', 14) + ' 回复</button></div>');
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
      if (!confirm('删除这条回复?')) return;
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
    if (!confirm('删除整个帖子(含所有回复)?')) return;
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
      '<div class="board-row" data-id="' + b.id + '"><input value="' + UI.esc(b.name) + '" data-f="name" maxlength="30">' +
      '<input value="' + UI.esc(b.descr) + '" data-f="descr" maxlength="100">' +
      '<button class="btn xs" data-op="save">保存</button><button class="btn xs danger" data-op="del">删除</button></div>').join('') +
    '</div>' +
    '<div class="board-row" style="margin-top:12px"><input id="nb-name" placeholder="新板块名" maxlength="30">' +
    '<input id="nb-descr" placeholder="描述(可选)" maxlength="100"><button class="btn xs primary" id="nb-add">添加</button></div>' });
  $$('.board-row [data-op]', m.body).forEach(b => b.onclick = async () => {
    const row = b.closest('.board-row'), id = +row.dataset.id;
    if (b.dataset.op === 'del') {
      if (!confirm('删除板块(含其中所有帖子)?')) return;
      try { await API.del('/api/admin/forum/boards/' + id); m.close(); renderForumList(); } catch (e) { toast(e.message, 'err'); }
    } else {
      try {
        await API.patch('/api/admin/forum/boards/' + id, {
          name: row.querySelector('[data-f=name]').value, descr: row.querySelector('[data-f=descr]').value
        });
        toast('已保存'); m.close(); renderForumList();
      } catch (e) { toast(e.message, 'err'); }
    }
  });
  m.body.querySelector('#nb-add').onclick = async () => {
    try { await API.post('/api/admin/forum/boards', { name: $('#nb-name').value, descr: $('#nb-descr').value }); m.close(); renderForumList(); }
    catch (e) { toast(e.message, 'err'); }
  };
}

/* ---------- 聊天 ----------
 * v1.27: 聊天整体迁到 web/js/chat.js(window.Chat), 做到微信级:
 *   私聊/群聊/官方大厅 · 未读角标与免打扰小红点 · 置顶 · 已读回执 ·
 *   正在输入 · 引用回复 · 表情回应 · @提醒 · 图片/文件/语音消息 ·
 *   群资料抽屉(改名/公告/群昵称/邀请/移出/转让/退群/解散) · 聊天记录搜索 ·
 *   向上翻页加载历史 · 拖拽与粘贴发图 · 桌面通知
 * 路由 #/chat → Chat.view(); 其它页面通过 Chat.refreshBadge() 维护导航角标,
 * 需要私聊某人时调用 Chat.openDM(uid)。
 */
window.openChatDM = function (uid) { if (window.Chat) Chat.openDM(uid); };

/* ---------- 顶栏公告/扫码 绑定(事件委托, 跨视图重渲染存活) ---------- */
document.addEventListener('click', e => {
  if (e.target.closest('#top-ann')) { openAnnPanel(); return; }
  if (e.target.closest('#top-qr')) { openScanModal(); return; }
});
