#!/bin/bash
# ================================================================
#  FLA (FYX Lesson All) HTTPS 签发与续签脚本 v1.26
#  用法:
#    sudo bash https.sh                    交互模式(直接回车 = 默认两个域名)
#    sudo bash https.sh 域名1 域名2 ...     非交互指定(可多个, 支持逗号分隔)
#    sudo bash https.sh --check            干跑: 只显示计划, 不改系统(无需 sudo)
#    sudo bash https.sh --status           查看证书/端口/配置状态
#    sudo bash https.sh --renew            手动续期一次
#  默认域名: t.clrv.top t.fyx.best
#  做四件事:
#   1. Let's Encrypt 多域名证书 (certbot --standalone, 智能借80:
#      只暂停真正占用 80 的服务, 签完立刻启回; FLA 在 80 或 8080 都适用)
#   2. 宿主机 nginx 443 反代到 FLA 实际端口(自动读 deploy/.env)
#   3. 自动续期: 每天 03:00/15:00 自检 + 续期钩子智能释放 80
#   4. 幂等: 重复运行安全; 证书未到期且域名都覆盖时不重签
# ================================================================
set -o pipefail

SCRIPT_DIR=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
LOG="$SCRIPT_DIR/https.log"
ENVF="$SCRIPT_DIR/deploy/.env"
DEFAULT_DOMS="t.clrv.top t.fyx.best"
CERT_NAME="fla"
CERT_DIR="/etc/letsencrypt/live/$CERT_NAME"
CONF="/etc/nginx/conf.d/fla-https.conf"

# ---------- 参数 ----------
MODE="run"; ASSUME_YES=0; DOMS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check)  MODE="check";  shift ;;
    --status) MODE="status"; shift ;;
    --renew)  MODE="renew";  shift ;;
    --yes)    ASSUME_YES=1;  shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,2\}//'; exit 0 ;;
    -*) echo "未知参数: $1 (用法见 --help)"; exit 1 ;;
    *) DOMS="$DOMS $1"; shift ;;
  esac
done
DOMS=$(echo "$DOMS" | tr ',' ' ')
DOMS=$(echo $DOMS 2>/dev/null)

log(){ local L="[$(date +%H:%M:%S)] $*"; echo "$L"; [ "$(id -u)" = "0" ] && echo "$L" >>"$LOG" 2>/dev/null; }

if [ "$MODE" != "check" ] && [ "$(id -u)" != "0" ]; then
  echo "✘ 请用 sudo 运行 (只看计划可用: bash https.sh --check)"
  exit 1
fi
[ "$(id -u)" = "0" ] && { : >"$LOG" 2>/dev/null; echo "===== FLA HTTPS v1.26 $(date '+%F %T') =====" >>"$LOG"; }

# FLA 实际端口
FPORT=$(grep -E '^PORT=' "$ENVF" 2>/dev/null | head -1 | cut -d= -f2)
FPORT=${FPORT:-80}

# ---------- 域名收集 ----------
if [ -z "$DOMS" ]; then
  if [ "$MODE" = "run" ] && [ -t 0 ] && [ "$ASSUME_YES" != "1" ]; then
    read -p "请输入域名(多个用空格/逗号分隔, 直接回车 = $DEFAULT_DOMS): " IN
    DOMS=${IN:-$DEFAULT_DOMS}
  else
    DOMS="$DEFAULT_DOMS"
  fi
fi
DOMS=$(echo "$DOMS" | tr ',' ' '); DOMS=$(echo $DOMS 2>/dev/null)
[ -n "$DOMS" ] || { echo "✘ 未提供域名"; exit 1; }
for d in $DOMS; do
  echo "$d" | grep -Eq '^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$' \
    || { echo "✘ 域名格式不对: $d"; exit 1; }
done
PRIMARY=$(echo $DOMS | awk '{print $1}')

# ---------- 函数 ----------
dns_check(){
  local IP DNSIP BAD=0 d
  IP=$(curl -sf -m 6 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
  log "本机公网IP: ${IP:-未知}"
  for d in $DOMS; do
    DNSIP=$(getent hosts "$d" 2>/dev/null | awk '{print $1}' | head -1)
    if [ -z "$DNSIP" ]; then log "  ⚠ $d: DNS 解析失败, 该域名会签发失败"; BAD=$((BAD+1))
    elif [ -n "$IP" ] && [ "$DNSIP" != "$IP" ]; then log "  ⚠ $d 解析到 $DNSIP ≠ 本机 $IP, 该域名大概率签发失败"; BAD=$((BAD+1))
    else log "  ✓ $d → $DNSIP"; fi
  done
  return $BAD
}

cert_fresh(){   # 证书存在 + 覆盖全部域名 + 30 天内不到期
  [ -f "$CERT_DIR/fullchain.pem" ] || return 1
  command -v openssl >/dev/null 2>&1 || return 0
  local TXT d
  TXT=$(openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -text 2>/dev/null) || return 1
  for d in $DOMS; do echo "$TXT" | grep -q "DNS:$d[, ]\|DNS:$d\$" || return 1; done
  openssl x509 -in "$CERT_DIR/fullchain.pem" -checkend $((30*24*3600)) -noout >/dev/null 2>&1 || return 1
  return 0
}

free_80(){      # 识别 80 占用者: FREE80 = fla | host | ""
  FREE80=""
  command -v ss >/dev/null 2>&1 || return 0
  ss -ltn 2>/dev/null | grep -q ':80 ' || return 0
  if docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -q 'nginx.*:80->'; then FREE80="fla"
  elif systemctl is-active nginx >/dev/null 2>&1 && ss -ltnp 2>/dev/null | grep ':80 ' | grep -q nginx; then FREE80="host"
  else log "  ⚠ 80 被其他进程占用: $(ss -ltnp 2>/dev/null | grep ':80 ' | head -1)"; fi
}

issue_cert(){
  command -v certbot >/dev/null 2>&1 || { apt-get install -y -qq certbot >>"$LOG" 2>&1 || yum install -y certbot >>"$LOG" 2>&1; }
  command -v certbot >/dev/null 2>&1 || { log "  ✘ certbot 安装失败(网络问题? 看 https.log)"; return 1; }
  local DOMARGS="" d
  for d in $DOMS; do DOMARGS="$DOMARGS -d $d"; done
  free_80
  if [ "$FREE80" = "fla" ]; then log "  暂停 nginx 释放 80 (签完自动启回)..."; docker stop nginx >>"$LOG" 2>&1; sleep 2
  elif [ "$FREE80" = "host" ]; then log "  暂停本机 nginx 释放 80 (签完自动启回)..."; systemctl stop nginx >>"$LOG" 2>&1; sleep 2
  else log "  80 空闲或占用者不明, 直接尝试签发..."; fi
  certbot certonly --standalone --cert-name "$CERT_NAME" $DOMARGS --expand \
    --non-interactive --agree-tos -m "admin@$PRIMARY" >>"$LOG" 2>&1
  local RC=$?
  [ "$FREE80" = "fla" ] && { docker start nginx >>"$LOG" 2>&1; sleep 3; }
  [ "$FREE80" = "host" ] && { systemctl start nginx >>"$LOG" 2>&1; sleep 1; }
  [ "$RC" = "0" ] && log "  ✔ 证书签发成功: $CERT_DIR (覆盖: $DOMS)"
  [ "$RC" = "0" ] || { log "  ✘ 签发失败(https.log 尾部有原因; 常见: DNS未指向本机 / 80不通 / 云安全组未放行80)"; return 1; }
  return 0
}

gen_conf(){     # $1=是否加 80→443 跳转(1/0)
  local NAMES="" d
  for d in $DOMS; do NAMES="$NAMES $d"; done
  printf '%s\n' 'server {' '    listen 443 ssl;' "    server_name$NAMES;" \
    "    ssl_certificate $CERT_DIR/fullchain.pem;" "    ssl_certificate_key $CERT_DIR/privkey.pem;" \
    '    client_max_body_size 600m;' '    location / {' \
    "        proxy_pass http://127.0.0.1:$FPORT;" '        proxy_http_version 1.1;' \
    '        proxy_set_header Upgrade $http_upgrade;' '        proxy_set_header Connection "upgrade";' \
    '        proxy_set_header Host $host;' '        proxy_set_header X-Forwarded-Proto https;' \
    '        proxy_set_header X-Real-IP $remote_addr;' '        proxy_read_timeout 300s;' '    }' '}'
  [ "$1" = "1" ] || return 0
  printf '%s\n' '' 'server {' '    listen 80;' "    server_name$NAMES;" '    return 301 https://$host$request_uri;' '}'
}

write_hooks(){
  mkdir -p /etc/letsencrypt/renewal-hooks/pre /etc/letsencrypt/renewal-hooks/post /etc/letsencrypt/renewal-hooks/deploy
  cat > /etc/letsencrypt/renewal-hooks/pre/fla-free80.sh <<'EOF'
#!/bin/bash
# FLA 证书续期: 暂时释放 80 端口(只停真正占用它的进程)
F80=""
if command -v ss >/dev/null 2>&1 && ss -ltn | grep -q ":80 "; then
  if docker ps --format "{{.Names}} {{.Ports}}" 2>/dev/null | grep -q "nginx.*:80->"; then F80="fla"; docker stop nginx 2>/dev/null
  elif systemctl is-active nginx >/dev/null 2>&1 && ss -ltnp 2>/dev/null | grep ":80 " | grep -q nginx; then F80="host"; systemctl stop nginx 2>/dev/null; fi
fi
echo "$F80" > /tmp/.fla-free80
exit 0
EOF
  cat > /etc/letsencrypt/renewal-hooks/post/fla-restore80.sh <<'EOF'
#!/bin/bash
# FLA 证书续期: 把为释放 80 而停掉的进程启回来
F80=$(cat /tmp/.fla-free80 2>/dev/null)
[ "$F80" = "fla" ] && docker start nginx 2>/dev/null
[ "$F80" = "host" ] && systemctl start nginx 2>/dev/null
rm -f /tmp/.fla-free80
systemctl reload nginx 2>/dev/null
exit 0
EOF
  cat > /etc/letsencrypt/renewal-hooks/deploy/fla-reload.sh <<'EOF'
#!/bin/bash
docker restart nginx 2>/dev/null
systemctl reload nginx 2>/dev/null
exit 0
EOF
  chmod +x /etc/letsencrypt/renewal-hooks/pre/fla-free80.sh \
           /etc/letsencrypt/renewal-hooks/post/fla-restore80.sh \
           /etc/letsencrypt/renewal-hooks/deploy/fla-reload.sh
}

setup_nginx(){
  local WASFREE=0
  command -v ss >/dev/null 2>&1 && ! ss -ltn 2>/dev/null | grep -q ':80 ' && WASFREE=1   # 必须在装 nginx 前测
  if ! command -v nginx >/dev/null 2>&1; then
    apt-get install -y -qq nginx >>"$LOG" 2>&1 || yum install -y nginx >>"$LOG" 2>&1
    command -v nginx >/dev/null 2>&1 || { log "  ✘ nginx 安装失败(看 https.log)"; return 1; }
    rm -f /etc/nginx/sites-enabled/default /etc/nginx/conf.d/default.conf 2>/dev/null
    log "  已安装宿主机 nginx (并清掉默认占位站点, 避免抢 80/443)"
  fi
  mkdir -p /etc/nginx/conf.d
  gen_conf "$WASFREE" > "$CONF"
  [ "$WASFREE" = "1" ] && log "  80 原本空闲: 已顺便加上 http→https 自动跳转" \
                        || log "  80 由其他服务使用: 不加跳转, 原 HTTP 访问保持不变"
  write_hooks
  (crontab -l 2>/dev/null | grep -v "certbot-fla"; echo "0 3,15 * * * certbot renew --quiet >>/var/log/certbot-fla.log 2>&1") | crontab - >>"$LOG" 2>&1
  log "  自动续期: 每天 03:00/15:00 自检 (手动: sudo bash https.sh --renew)"
  nginx -t >>"$LOG" 2>&1 || { log "  ✘ nginx 配置语法错误(看 https.log)"; return 1; }
  systemctl enable nginx >>"$LOG" 2>&1
  if systemctl is-active nginx >/dev/null 2>&1; then
    systemctl reload nginx >>"$LOG" 2>&1 || systemctl restart nginx >>"$LOG" 2>&1
  else
    systemctl restart nginx >>"$LOG" 2>&1
  fi
  sleep 1
  if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ':443 '; then
    log "  ✔ 443 已监听 → 反代 127.0.0.1:$FPORT"
  else
    log "  ⚠ 443 未监听! 看 https.log 和 /var/log/nginx/error.log; 云服务器还需在控制台安全组放行 443"
    return 1
  fi
  return 0
}

# ---------- 模式分发 ----------
case "$MODE" in
check)
  echo "===== 干跑模式(不改动系统) ====="
  echo "域名:      $DOMS"
  echo "主域名:    $PRIMARY"
  echo "FLA 端口:  $FPORT (deploy/.env)"
  [ -f "$ENVF" ] || echo "⚠ 未找到 deploy/.env (FLA 可能未部署), 端口按 80 处理"
  if [ -f "$CERT_DIR/fullchain.pem" ] && cert_fresh; then echo "现有证书:   可复用(覆盖全部域名且未到期)"
  elif [ -f "$CERT_DIR/fullchain.pem" ]; then echo "现有证书:   存在但不满足(域名不全或临期) → 将重签/扩展"
  else echo "现有证书:   无 → 将新签发"; fi
  free_80
  echo "80 占用者: ${FREE80:-空闲} $([ "$FREE80" = "fla" ] && echo '(签发时将暂停 nginx, 完成后自动启回)')$([ "$FREE80" = "host" ] && echo '(签发时将暂停本机 nginx, 完成后自动启回)')"
  echo "---- 将写入 $CONF ----"
  WASFREE=0; command -v ss >/dev/null 2>&1 && ! ss -ltn 2>/dev/null | grep -q ':80 ' && WASFREE=1
  gen_conf "$WASFREE"
  echo "---- 续期钩子将写入 /etc/letsencrypt/renewal-hooks/{pre,post,deploy} ----"
  exit 0 ;;
status)
  echo "===== FLA HTTPS 状态 ====="
  echo "FLA 端口(deploy/.env): $FPORT"
  if [ -f "$CERT_DIR/fullchain.pem" ]; then
    openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -enddate 2>/dev/null
    echo "覆盖域名: $(openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -text 2>/dev/null | grep -A1 'Alternative' | tail -1 | tr -d ' ')"
  else echo "证书: 未签发"; fi
  [ -f "$CONF" ] && { echo "nginx 配置: $CONF"; grep -E 'listen|server_name|proxy_pass' "$CONF"; } || echo "nginx 配置: 无"
  command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -E ':(80|443) ' || echo "80/443: 均未监听"
  crontab -l 2>/dev/null | grep -q certbot && echo "自动续期: 已配置" || echo "自动续期: 未配置"
  exit 0 ;;
renew)
  log "===== 手动续期 ====="
  command -v certbot >/dev/null 2>&1 || { log "✘ certbot 未安装, 先运行 sudo bash https.sh"; exit 1; }
  certbot renew >>"$LOG" 2>&1 && log "✔ 续期检查完成(未到期会自动跳过)" || log "✘ 续期失败(看 https.log)"
  exit 0 ;;
esac

# ---------- 正式签发 ----------
log "===== FLA HTTPS 签发 | 域名:$DOMS ====="
dns_check; NBD=$?
if [ "$NBD" -gt 0 ] && [ "$ASSUME_YES" != "1" ] && [ -t 0 ]; then
  read -p "有 $NBD 个域名解析异常, 仍然继续? [y/N] " A
  [ "$A" = "y" ] || { log "已取消"; exit 1; }
fi
if cert_fresh; then
  log "证书已存在且覆盖全部域名、30 天内不到期 → 复用, 不重签"
else
  issue_cert || exit 1
fi
setup_nginx || exit 1
log "===== ✔ HTTPS 就绪 ====="
for d in $DOMS; do log "  https://$d  (443 → 127.0.0.1:$FPORT)"; done
log "  老师请改用 https://$PRIMARY 访问 (页码视觉同步/屏幕捕获需要 HTTPS)"
log "  排错: sudo bash https.sh --status | tail -50 https.log"
exit 0
