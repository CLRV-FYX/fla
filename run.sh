#!/bin/bash
# ================================================================
#  FLA (FYX Lesson All) 日常管理脚本
#  用法:  sudo bash run.sh {status|start|stop|restart|logs|update|screen}
#    status   查看容器与服务的运行状态
#    start    启动(开机也会自动启动, 此为手动停止后再启动)
#    stop     停止(容器保留, 数据不丢)
#    restart  重启
#    logs     查看实时日志, 可选指定服务: run.sh logs [app|nginx|documentserver]
#    update   更新/重新部署版本(智能重建容器, 数据保留, 自动进 screen)
#    screen   查看正在进行的安装会话(如果有)
#    doctor   一键诊断: 收集全部容器日志/网络/健康检查到 doctor.log
#    ds-remove 删除 OnlyOffice 容器并重启 (v1.19: Office 已改用微软在线渲染)
# ================================================================
set -u
cd "$(dirname "$0")"

if [ "$(id -u)" != "0" ]; then
  echo "请用 root 运行: sudo bash run.sh {status|start|stop|restart|logs|update}"
  exit 1
fi

DC=""
if docker compose version >/dev/null 2>&1; then DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"
else echo "✘ 未找到 docker compose"; exit 1; fi

CF=$(cat deploy/.compose_file 2>/dev/null)
if [ -z "$CF" ] || [ ! -f "$CF" ]; then
  if [ -f deploy/docker-compose.direct.yml ] && grep -q '^DS_PORT=' deploy/.env 2>/dev/null; then
    CF="deploy/docker-compose.direct.yml"
  elif docker images 2>/dev/null | grep -q 'onlyoffice/documentserver'; then
    CF="deploy/docker-compose.yml"
  else
    CF="deploy/docker-compose.lite.yml"
  fi
fi
PROF=$(cat deploy/.compose_profile 2>/dev/null)
DCP=""
[ -n "$PROF" ] && DCP="--profile $PROF"
PORT=$(grep -E '^PORT=' deploy/.env 2>/dev/null | head -1 | cut -d= -f2)
PORT=${PORT:-80}

case "${1:-help}" in
  https)
    shift
    exec bash ./https.sh "$@"
    ;;
  status)
    echo "── FLA 容器状态 (compose: $CF ${PROF:+profile:$PROF}) ──"
    docker ps -a --filter name=fla --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
    echo ""
    echo "── 健康检查 ──"
    if curl -sf -m 4 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      echo "✔ 服务正常  http://127.0.0.1:$PORT/"
    else
      echo "✘ 服务未响应 (http://127.0.0.1:$PORT/api/health)"
      echo "  排查: sudo bash run.sh logs app"
    fi
    ;;
  start)
    echo ">> 启动 FLA ..."
    $DC $DCP -f "$CF" up -d || { echo "✘ 启动失败, 查看日志: sudo bash run.sh logs"; exit 1; }
    for i in $(seq 1 20); do
      curl -sf -m 3 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && { echo "✔ 已启动"; exit 0; }
      sleep 3
    done
    echo "⚠ 容器已启动但健康检查未通过, 请稍候或查看: sudo bash run.sh logs app"
    ;;
  stop)
    echo ">> 停止 FLA (数据保留) ..."
    $DC $DCP -f "$CF" stop
    echo "✔ 已停止 (重新启动: sudo bash run.sh start)"
    ;;
  restart)
    echo ">> 重启 FLA ..."
    $DC $DCP -f "$CF" restart
    for i in $(seq 1 20); do
      curl -sf -m 3 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && { echo "✔ 已重启"; exit 0; }
      sleep 3
    done
    echo "⚠ 重启完成但健康检查未通过, 请查看: sudo bash run.sh logs app"
    ;;
  logs)
    shift
    SVC="${1:-}"
    if [ -n "$SVC" ]; then
      $DC $DCP -f "$CF" logs -f --tail=200 "$SVC"
    else
      $DC $DCP -f "$CF" logs -f --tail=200
    fi
    ;;
  update)
    shift
    echo ">> 重新运行 install.sh (智能重建, 数据保留) ..."
    exec bash "$PWD/install.sh" "$@"
    ;;
  ds-remove)
    echo ">> 移除 OnlyOffice 容器 (v1.19: Office 已改用微软在线渲染) ..."
    if ! command -v docker >/dev/null 2>&1; then echo "✘ 未安装 docker"; exit 1; fi
    C=$(docker ps -a --format '{{.Names}}\t{{.Image}}' 2>/dev/null | grep -iE 'onlyoffice|documentserver' | cut -f1)
    if [ -z "$C" ]; then
      echo "  (未发现 OnlyOffice 容器)"
    else
      for c in $C; do
        docker rm -f "$c" >/dev/null 2>&1 && echo "  ✔ 已删除容器: $c"
      done
    fi
    sed -i 's/^ONLYOFFICE_URL=.*/ONLYOFFICE_URL=/' deploy/.env 2>/dev/null
    echo "  ✔ 已清空 ONLYOFFICE_URL 配置"
    if [ -f "$CF" ]; then
      echo ">> 重启 FLA (应用新配置) ..."
      $DC $DCP -f "$CF" up -d --force-recreate app 2>/dev/null || $DC $DCP -f "$CF" up -d
    fi
    echo "完成: Office 预览/放映现在走微软在线渲染 (需域名+80/443)"
    ;;
  doctor)
    OUT="$PWD/doctor.log"
    {
      echo "===== FLA 诊断报告 $(date '+%F %T') ====="
      echo "--- 当前 compose 配置 ---"
      echo "file: $CF  profile: ${PROF:-无}"
      echo "--- .env (敏感信息已脱敏) ---"
      sed -E 's/(PASSWORD|SECRET)=.*/\1=***(已隐藏)/' deploy/.env 2>/dev/null || echo "(无 .env)"
      echo "--- 容器状态 ---"
      docker ps -a --filter name=fla --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
      echo "--- 健康检查 (本地:$PORT) ---"
      curl -sf -m 4 "http://127.0.0.1:$PORT/api/health" && echo " <- OK" || echo "✘ 本地 $PORT 不通"
      echo "--- 容器网络 ---"
      docker inspect fla --format 'fla 网络: {{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null
      docker inspect nginx --format 'nginx 网络: {{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null || echo "(nginx 不存在)"
      echo "--- DNS 解析测试 (从 nginx 容器内解析 app) ---"
      docker exec nginx nslookup app 2>&1 | head -5 || true
      echo "--- OnlyOffice 密钥对比 ---"
      DS_C=$(docker ps --format '{{.Names}}' | grep -iE 'onlyoffice|documentserver' | head -1)
      if [ -n "$DS_C" ]; then
        APP_S=$(grep '^ONLYOFFICE_JWT_SECRET=' deploy/.env 2>/dev/null | cut -d= -f2)
        DS_S=$(docker exec "$DS_C" /var/www/onlyoffice/documentserver/npm/json -f /etc/onlyoffice/documentserver/local.json services.CoAuthoring.secret.session.string 2>/dev/null | tr -d '"')
        fp(){ local s=$1; if [ -n "$s" ]; then echo "${s:0:4}...${s: -4} (len=${#s})"; else echo "(空)"; fi; }
        echo "FLA .env 密钥:   $(fp "$APP_S")"
        echo "DS session 密钥: $(fp "$DS_S")"
        if [ "$APP_S" = "$DS_S" ]; then echo "→ 一致"; else echo "→ 不一致! 重跑 sudo bash install.sh 自动校准"; fi
        if docker exec "$DS_C" test -f /usr/share/fonts/truetype/fla/.fla_fonts_v1 2>/dev/null; then
          echo "--- OnlyOffice 中文字体: 已注入(v1.26) ---"
        else
          echo "--- OnlyOffice 中文字体: 未注入 (PPT 字体错位时重跑 sudo bash install.sh) ---"
        fi
      else
        echo "(未发现运行中的 OnlyOffice 容器)"
      fi
      echo "--- fla 日志 (最后60行) ---"
      docker logs --tail 60 fla 2>&1
      echo "--- nginx 日志 (最后60行) ---"
      docker logs --tail 60 nginx 2>&1 || echo "(nginx 不存在)"
      echo "--- 资源 ---"
      free -m | head -2
      df -h / | tail -1
      echo "===== 诊断结束 ====="
    } | tee "$OUT"
    echo ""
    echo "诊断完成: 已生成 $OUT — 把这个文件发给开发者即可定位问题"
    ;;
  screen)
    if command -v screen >/dev/null 2>&1 && screen -ls 2>/dev/null | grep -q fla-install; then
      exec screen -r fla-install
    else
      echo "当前没有进行中的安装会话"
      echo "历史安装日志: less $PWD/install.log"
    fi
    ;;
  *)
    grep '^#' "$0" | sed 's/^# \{0,2\}//' | head -14
    ;;
esac
