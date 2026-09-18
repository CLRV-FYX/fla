#!/bin/bash
# ================================================================
#  FLA 边缘网关 (edge nginx) — 占用 80/443, 接管所有域名指向
#  ----------------------------------------------------------------
#  作用:
#   1. 在宿主机安装/复用 nginx, 让它独占 80 与 443
#   2. server_name _ + default_server  →  任何解析到本机的域名/IP 都落到 FLA
#   3. 反向代理到 FLA 应用端口 (默认 8306, 读 deploy/.env 的 PORT)
#   4. 预置 /.well-known/acme-challenge/ 文件验证目录 (HTTP-01 签发证书用,
#      签发/续期期间 nginx 不需要停机)
#   5. 还没有正式证书时, 自动生成自签证书兜底 → 443 立即可用
#
#  用法:
#    sudo bash edge.sh setup   [域名...]   安装/更新边缘网关(默认动作)
#    sudo bash edge.sh status              查看 80/443 监听与反代目标
#    sudo bash edge.sh reload              校验配置并重载
#    sudo bash edge.sh remove              移除 FLA 边缘网关配置(不卸载 nginx)
#    sudo bash edge.sh --port 8306 setup   手动指定 FLA 端口
#
#  与其他脚本的关系:
#    install.sh  会自动调用  edge.sh setup  +  https.sh(文件验证签发证书)
#    https.sh    只负责证书, 配置由本脚本生成(证书签发后自动 reload)
# ================================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
LOG="${FLA_EDGE_LOG:-$SCRIPT_DIR/edge.log}"

CONF="/etc/nginx/conf.d/fla-edge.conf"
CERT_DIR="/etc/fla/ssl"
CERT="$CERT_DIR/fullchain.pem"
KEY="$CERT_DIR/privkey.pem"
WEBROOT="/var/www/fla-acme"
STATE="/etc/fla/edge.state"          # 记录已配置域名, 供 https.sh / run.sh 复用

# ---------- 参数 ----------
ACTION="setup"; DOMS=""; PORT_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    setup|status|reload|remove|-h|--help) ACTION="${1#-}"; [ "$ACTION" = "help" ] && ACTION="--help"; shift ;;
    --port) PORT_OVERRIDE="${2:-}"; shift 2 ;;
    --domain|--domains) DOMS="$DOMS ${2:-}"; shift 2 ;;
    --yes|-y) shift ;;
    -*) echo "未知参数: $1"; exit 1 ;;
    *) DOMS="$DOMS $1"; shift ;;
  esac
done
[ "$ACTION" = "--help" ] && { grep '^#' "$0" | sed 's/^# \{0,2\}//'; exit 0; }

DOMS=$(echo "$DOMS" | tr ',' ' '); DOMS=$(echo $DOMS)

log(){ local L="[$(date '+%H:%M:%S')] $*"; echo "$L"; echo "$L" >>"$LOG" 2>/dev/null; }
die(){ log "✘ $*"; exit 1; }
try(){ "$@" >>"$LOG" 2>&1; }

# ---------- 读取 FLA 端口与历史域名 ----------
fla_port(){
  local P=""
  [ -n "$PORT_OVERRIDE" ] && P="$PORT_OVERRIDE"
  [ -z "$P" ] && P=$(grep -E '^PORT=' deploy/.env 2>/dev/null | head -1 | cut -d= -f2)
  [ -z "$P" ] && P=$(grep -E '^PORT=' "$STATE" 2>/dev/null | head -1 | cut -d= -f2)
  echo "${P:-8306}"
}
saved_doms(){ grep -E '^DOMAINS=' "$STATE" 2>/dev/null | head -1 | cut -d= -f2-; }

PORT=$(fla_port)
[ -z "$DOMS" ] && DOMS=$(saved_doms)

save_state(){
  mkdir -p "$(dirname "$STATE")" 2>/dev/null
  {
    echo "# FLA 边缘网关状态 (由 edge.sh 维护)"
    echo "PORT=$PORT"
    echo "DOMAINS=$DOMS"
    echo "UPDATED=$(date '+%F %T')"
  } > "$STATE" 2>/dev/null
}

detect_os(){
  if [ -f /etc/centos-release ] || [ -f /etc/redhat-release ]; then OS="rh"; PKG="yum"
  elif [ -f /etc/debian_version ]; then OS="deb"; PKG="apt"
  else OS="other"; PKG=""; fi
  command -v dnf >/dev/null 2>&1 && PKG="dnf"
}
detect_os

nginx_ver(){ nginx -v 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1; }
ver_ge(){   # ver_ge A B → A >= B ?
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]
}

listen_80_free(){
  command -v ss >/dev/null 2>&1 || return 0
  ss -ltn 2>/dev/null | grep -Eq '(:80|:443)\s' && return 1
  return 0
}
who_holds_80(){
  command -v ss >/dev/null 2>&1 || { echo "(无 ss 命令)"; return; }
  ss -ltnp 2>/dev/null | grep -E ':80\s' | head -2
  docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -E '0\.0\.0\.0:(80|443)->' | head -3
}

# ================================================================
#  1. 安装 nginx
# ================================================================
install_nginx(){
  if command -v nginx >/dev/null 2>&1; then
    log "✔ 宿主机已安装 nginx: $(nginx_ver)"
    return 0
  fi
  log "安装宿主机 nginx ..."
  case "$PKG" in
    dnf|yum)
      try $PKG install -y nginx
      if ! command -v nginx >/dev/null 2>&1; then
        # CentOS 7/8 需要 EPEL
        try $PKG install -y epel-release
        try $PKG install -y nginx
      fi
      ;;
    apt)
      try apt-get update
      try apt-get install -y --no-install-recommends nginx
      ;;
  esac
  command -v nginx >/dev/null 2>&1 || return 1
  log "✔ nginx 安装完成: $(nginx_ver)"
  return 0
}

# ================================================================
#  2. 让开 80/443: 停用发行版默认站点 + 检查冲突
# ================================================================
free_ports(){
  local moved=0 f
  # 发行版默认站点会抢 default_server, 改名保留(不删)
  for f in /etc/nginx/conf.d/default.conf /etc/nginx/sites-enabled/default \
           /etc/nginx/default.d/*.conf; do
    [ -f "$f" ] || continue
    if grep -Eq 'listen[^;]*(default_server|80|443)' "$f" 2>/dev/null; then
      mv -f "$f" "$f.fla-disabled" 2>/dev/null && moved=$((moved+1)) \
        && log "  已停用默认站点: $f → $f.fla-disabled"
    fi
  done
  [ "$moved" = "0" ] && log "  (无需停用默认站点)"

  # 其他进程占用 80/443 (apache / 别的 docker 容器)
  local holders
  holders=$(who_holds_80)
  if systemctl is-active nginx >/dev/null 2>&1; then
    : # 我们自己的 nginx, 正常
  elif [ -n "$holders" ]; then
    log "  ⚠ 80/443 目前被其他程序占用:"
    echo "$holders" | sed 's/^/      /' | tee -a "$LOG"
    if systemctl is-active httpd >/dev/null 2>&1 || systemctl is-active apache2 >/dev/null 2>&1; then
      log "  检测到 Apache(httpd/apache2) 正在占用 80/443 → 停用并禁止自启(可用 systemctl start httpd 恢复)"
      try systemctl stop httpd; try systemctl disable httpd
      try systemctl stop apache2; try systemctl disable apache2
    fi
    # docker 容器占用: 只提示, 不擅自删除用户的容器
    docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -E '0\.0\.0\.0:(80|443)->' | while read -r line; do
      log "  ⚠ 容器占用 80/443: $line"
      log "    处理办法(任选其一): docker stop ${line%% *} / 改它的端口映射 / 让 FLA 换端口 --port 8307"
    done
  fi
}

# ================================================================
#  3. 自签证书兜底 (没有正式证书时让 443 立即可用)
# ================================================================
bootstrap_cert(){
  mkdir -p "$CERT_DIR" "$WEBROOT/.well-known/acme-challenge"
  chmod -R a+rX "$WEBROOT" 2>/dev/null
  if [ -s "$CERT" ] && [ -s "$KEY" ]; then
    log "  证书已存在: $CERT (正式证书由 https.sh 用文件验证签发后覆盖)"
    return 0
  fi
  command -v openssl >/dev/null 2>&1 || { log "  ⚠ 无 openssl, 跳过自签证书(443 暂不可用)"; return 1; }
  log "  生成自签证书兜底 (浏览器会提示不受信任, 正式证书签发后自动替换) ..."
  local SAN="DNS:localhost,IP:127.0.0.1" d ip
  for d in $DOMS; do SAN="$SAN,DNS:$d,DNS:www.$d"; done
  ip=$(curl -sf -m 6 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
  [ -n "$ip" ] && SAN="$SAN,IP:$ip"
  if openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
      -keyout "$KEY.fla-selfsigned" -out "$CERT.fla-selfsigned" \
      -subj "/CN=FLA Edge/O=FLA/C=HK" -addext "subjectAltName=$SAN" >>"$LOG" 2>&1 \
     || openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
      -keyout "$KEY.fla-selfsigned" -out "$CERT.fla-selfsigned" \
      -subj "/CN=FLA Edge/O=FLA/C=HK" >>"$LOG" 2>&1; then
    # 只有当前证书缺失或是自签时才覆盖(别把 Let's Encrypt 证书盖掉)
    if [ ! -s "$CERT" ] || grep -q 'FLA Edge' <(openssl x509 -in "$CERT" -noout -subject 2>/dev/null); then
      cp -f "$CERT.fla-selfsigned" "$CERT"; cp -f "$KEY.fla-selfsigned" "$KEY"
      chmod 600 "$KEY"; chmod 644 "$CERT"
      log "  ✔ 自签证书就绪: $CERT"
    fi
  else
    log "  ⚠ 自签证书生成失败(看 edge.log), 443 暂不可用; 80 不受影响"
    return 1
  fi
  return 0
}

# ================================================================
#  4. 生成 nginx 配置 (80/443 catch-all → 127.0.0.1:$PORT)
# ================================================================
gen_conf(){
  local d
  # ---- 强制跳 https 的域名 map (只对已签发证书的域名跳转) ----
  local MAPBODY=""
  for d in $DOMS; do
    MAPBODY="$MAPBODY
    $d            1;
    www.$d        1;"
  done

  local HAVECERT=0
  [ -s "$CERT" ] && [ -s "$KEY" ] && HAVECERT=1

  # ---- http2 写法按 nginx 版本适配 (1.25.1+ 用 http2 on;) ----
  local L443="    listen 443 ssl;" L443v6="    listen [::]:443 ssl;" HTTP2="    http2 on;"
  local V; V=$(nginx_ver)
  if [ -n "$V" ] && ! ver_ge "$V" "1.25.1"; then
    L443="    listen 443 ssl http2;"; L443v6="    listen [::]:443 ssl http2;"; HTTP2=""
  fi

  local TLSBLOCK=""
  if [ "$HAVECERT" = "1" ]; then
    TLSBLOCK="
server {
$L443
$L443v6
    server_name _;                                # ← 接管所有域名 (catch-all)
$HTTP2

    ssl_certificate     $CERT;
    ssl_certificate_key $KEY;
    ssl_session_cache   shared:FLA_SSL:12m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
    ssl_prefer_server_ciphers off;
    add_header Strict-Transport-Security \"max-age=31536000\" always;

__PROXY__
}"
  fi

  cat > "$CONF.tmp" <<EOF
# ================================================================
#  FLA 边缘网关 — 由 edge.sh 自动生成, 请勿手工编辑
#  · 80 / 443 由本文件的 default_server 接管: 任何指向本机的域名都落到 FLA
#  · 反向代理目标: http://127.0.0.1:$PORT   (FLA 应用端口)
#  · 证书: $CERT
#    自签=临时兜底; 正式证书由 https.sh 以【文件验证 HTTP-01】签发后自动替换
#  · 重新生成: sudo bash edge.sh setup   查看状态: sudo bash edge.sh status
# ================================================================

map \$http_upgrade \$connection_upgrade {
    default upgrade;
    ''      close;
}

# 已签发证书的域名 → http 自动跳 https (其余域名/IP 保持 http 直连, 避免证书告警)
map \$host \$fla_force_https {
    default       0;$MAPBODY
}

upstream fla_backend {
    server 127.0.0.1:$PORT max_fails=3 fail_timeout=10s;
    keepalive 32;
}

server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;                                # ← 接管所有域名 (catch-all)

    # Let's Encrypt 文件验证 (HTTP-01): 必须永远能用 http 取到
    location ^~ /.well-known/acme-challenge/ {
        root $WEBROOT;
        default_type "text/plain";
        charset utf-8;
        try_files \$uri =404;
    }

    # 已签发证书的域名 → 跳 https。
    # 注意: server 级 if 在 SERVER_REWRITE 阶段执行(早于 location 匹配),
    # 所以必须显式排除 ACME 路径, 否则续期请求会被 301 到 https, 文件验证失败。
    set \$fla_redir 0;
    if (\$fla_force_https) { set \$fla_redir 1; }
    if (\$uri ~ "^/.well-known/acme-challenge/") { set \$fla_redir 0; }
    if (\$fla_redir) { return 301 https://\$host\$request_uri; }

__PROXY__
}
$TLSBLOCK
EOF

  # ---- 公共反代段 (80/443 共用) ----
  local PROXY
  PROXY=$(cat <<EOF
    client_max_body_size 2048m;                    # 大课件上传
    proxy_read_timeout   600s;
    proxy_send_timeout   600s;
    proxy_connect_timeout 15s;

    gzip on;
    gzip_min_length 1024;
    gzip_comp_level 5;
    gzip_vary on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml font/woff2;

    location / {
        proxy_pass http://fla_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection        \$connection_upgrade;
        proxy_set_header Upgrade           \$http_upgrade;      # WebSocket (聊天实时推送)
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host  \$host;
        proxy_set_header X-Forwarded-Port  \$server_port;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;                                       # 音视频 Range 流式
        proxy_request_buffering off;                               # 大文件直传
        proxy_next_upstream error timeout http_502 http_503 http_504;
    }
EOF
)
  # 用 awk 替换占位符(避免 sed 对多行/特殊字符的转义地狱)
  awk -v proxy="$PROXY" '{ if ($0 == "__PROXY__") print proxy; else print }' "$CONF.tmp" > "$CONF"
  rm -f "$CONF.tmp"
  chmod 644 "$CONF"
}

# ================================================================
#  5. 防火墙 / SELinux
# ================================================================
open_firewall(){
  if systemctl is-active firewalld >/dev/null 2>&1; then
    local need=0 p
    for p in 80 443; do
      firewall-cmd --query-port="$p/tcp" >/dev/null 2>&1 || { try firewall-cmd --permanent --add-port="$p/tcp"; need=1; }
      firewall-cmd --query-service=https >/dev/null 2>&1 || { try firewall-cmd --permanent --add-service=http; try firewall-cmd --permanent --add-service=https; need=1; }
    done
    [ "$need" = "1" ] && { try firewall-cmd --reload; log "  ✔ 防火墙已放行 80/443 (云服务器还需在控制台安全组放行)"; }
  fi
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi active; then
    try ufw allow 80/tcp; try ufw allow 443/tcp
    log "  ✔ ufw 已放行 80/443"
  fi
  # SELinux: 允许 nginx 发起对外/本机端口的反代连接, 否则 502
  if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce 2>/dev/null)" = "Enforcing" ]; then
    if command -v setsebool >/dev/null 2>&1; then
      try setsebool -P httpd_can_network_connect 1
      log "  ✔ SELinux: 已允许 nginx 反代 (httpd_can_network_connect=1)"
    fi
    command -v semanage >/dev/null 2>&1 && try semanage port -a -t http_port_t -p tcp "$PORT" 2>/dev/null
  fi
}

start_nginx(){
  try systemctl enable nginx
  nginx -t >>"$LOG" 2>&1 || { log "✘ nginx 配置校验失败:"; tail -20 "$LOG"; return 1; }
  if systemctl is-active nginx >/dev/null 2>&1; then
    try systemctl reload nginx || try systemctl restart nginx
  else
    try systemctl restart nginx || try systemctl start nginx
  fi
  sleep 1
  systemctl is-active nginx >/dev/null 2>&1 || { log "✘ nginx 启动失败:"; try journalctl -u nginx --no-pager -n 20; tail -20 "$LOG"; return 1; }
  return 0
}

# ================================================================
#  动作
# ================================================================
do_setup(){
  [ "$(id -u)" = "0" ] || die "请用 root 运行: sudo bash edge.sh setup"
  : >"$LOG" 2>/dev/null
  log "===== FLA 边缘网关 (80/443 → 127.0.0.1:$PORT) ====="
  log "接管域名: ${DOMS:-（未指定: 所有域名/IP 均走 catch-all）}"

  install_nginx || die "nginx 安装失败(网络问题?) — 看 $LOG; 或手动安装后重跑: sudo bash edge.sh setup"
  free_ports
  bootstrap_cert
  gen_conf
  open_firewall
  start_nginx || die "nginx 启动失败 — 看 $LOG 与 journalctl -u nginx"
  save_state

  local L80=0 L443=0
  command -v ss >/dev/null 2>&1 && { ss -ltn 2>/dev/null | grep -q ':80 ' && L80=1; ss -ltn 2>/dev/null | grep -q ':443 ' && L443=1; }
  echo ""
  log "================================================"
  [ "$L80" = "1" ]  && log "  ✔ 80  已监听 (default_server, 接管所有域名)" || log "  ✘ 80  未监听!"
  [ "$L443" = "1" ] && log "  ✔ 443 已监听 (default_server, 接管所有域名)" || log "  ⚠ 443 未监听 (证书缺失?)"
  log "  → 反向代理目标: http://127.0.0.1:$PORT"
  if curl -sf -m 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    log "  ✔ FLA 应用健康 (127.0.0.1:$PORT)"
  else
    log "  ⚠ FLA 应用未在 $PORT 响应 — 先完成部署: sudo bash install.sh"
  fi
  if curl -sf -m 5 -H 'Host: any.example.com' "http://127.0.0.1/api/health" >/dev/null 2>&1; then
    log "  ✔ 经 nginx 80 的访问已打通 (任意域名均可)"
  fi
  for d in $DOMS; do log "    http://$d  /  https://$d"; done
  log "  正式证书(文件验证): sudo bash https.sh ${DOMS}"
  log "================================================"
}

do_status(){
  echo "===== FLA 边缘网关状态 ====="
  echo "配置文件:   $CONF $([ -f "$CONF" ] && echo '(存在)' || echo '(未生成)')"
  echo "反代目标:   127.0.0.1:$PORT  (FLA 应用端口)"
  echo "接管域名:   ${DOMS:-（无固定域名, 全部 catch-all）}"
  echo "证书:       $CERT"
  if [ -s "$CERT" ] && command -v openssl >/dev/null 2>&1; then
    openssl x509 -in "$CERT" -noout -subject -enddate 2>/dev/null | sed 's/^/            /'
    if openssl x509 -in "$CERT" -noout -issuer 2>/dev/null | grep -q 'FLA Edge'; then
      echo "            ⚠ 当前是自签兜底证书 → sudo bash https.sh 域名 签发正式证书"
    else
      echo "            ✔ 正式证书 (Let's Encrypt)"
    fi
  else
    echo "            (无)"
  fi
  echo "文件验证根: $WEBROOT/.well-known/acme-challenge/"
  echo "-- 80/443 监听 --"
  command -v ss >/dev/null 2>&1 && ss -ltnp 2>/dev/null | grep -E ':(80|443)\s' | sed 's/^/  /' || echo "  (无 ss)"
  echo "-- 连通性 --"
  curl -sf -m 4 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && echo "  ✔ FLA 应用 127.0.0.1:$PORT" || echo "  ✘ FLA 应用 127.0.0.1:$PORT 无响应"
  curl -sf -m 4 -H 'Host: test.local' http://127.0.0.1/api/health >/dev/null 2>&1 && echo "  ✔ nginx 80 → FLA" || echo "  ✘ nginx 80 → FLA 不通"
  curl -sfk -m 4 -H 'Host: test.local' https://127.0.0.1/api/health >/dev/null 2>&1 && echo "  ✔ nginx 443 → FLA" || echo "  ✘ nginx 443 → FLA 不通"
  command -v nginx >/dev/null 2>&1 && { echo "-- nginx 版本 --"; nginx -v 2>&1 | sed 's/^/  /'; }
}

do_remove(){
  [ "$(id -u)" = "0" ] || die "请用 root 运行"
  [ -f "$CONF" ] && { mv -f "$CONF" "$CONF.removed.$(date +%s)"; log "已移除 $CONF (备份保留)"; }
  local f
  for f in /etc/nginx/conf.d/*.fla-disabled /etc/nginx/sites-enabled/*.fla-disabled; do
    [ -f "$f" ] && mv -f "$f" "${f%.fla-disabled}" && log "已恢复默认站点: ${f%.fla-disabled}"
  done
  command -v nginx >/dev/null 2>&1 && nginx -t >>"$LOG" 2>&1 && { try systemctl reload nginx; log "nginx 已重载"; }
}

case "$ACTION" in
  setup)  do_setup ;;
  status) do_status ;;
  reload) [ "$(id -u)" = "0" ] || die "请用 root 运行"
          PORT=$(fla_port); gen_conf; start_nginx && log "✔ 配置已重新生成并重载 (→127.0.0.1:$PORT)" ;;
  remove) do_remove ;;
  *)      grep '^#' "$0" | sed 's/^# \{0,2\}//' ;;
esac
