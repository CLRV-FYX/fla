#!/bin/bash
# FLA 卸载脚本: 停止并删除 FLA 容器与数据卷
# ⚠ 会删除全部用户/课件/批注数据, 不可恢复
# 镜像默认保留(避免误删你自己构建/修改过的镜像), 需要删镜像请加 --images
set -u
[ "$(id -u)" = "0" ] || { echo "请用 root 运行: sudo bash uninstall.sh"; exit 1; }
cd "$(dirname "$0")"

RMIMG=0
[ "${1:-}" = "--images" ] && RMIMG=1

DC=""
if docker compose version >/dev/null 2>&1; then DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"
else echo "未找到 docker compose"; exit 1; fi

echo "⚠ 这将删除 FLA 的容器和全部数据(用户/课件/批注), 且不可恢复!"
read -p "输入 yes 确认删除: " A
[ "$A" = "yes" ] || { echo "已取消"; exit 0; }

$DC -f deploy/docker-compose.yml down -v --remove-orphans 2>/dev/null
$DC -f deploy/docker-compose.lite.yml down -v --remove-orphans 2>/dev/null
[ -f deploy/docker-compose.direct.yml ] && $DC --profile full -f deploy/docker-compose.direct.yml down -v --remove-orphans 2>/dev/null
# 兜底清理(处理改名/历史遗留)
docker rm -f fla nginx fla-onlyoffice 2>/dev/null
docker volume rm -f fla-data deploy_fla-data 2>/dev/null
rm -f deploy/.compose_file deploy/.compose_profile

if [ "$RMIMG" = "1" ]; then
  echo ">> 删除 FLA 相关镜像 ..."
  docker rmi -f onlyoffice/documentserver:latest 2>/dev/null
  docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^(deploy-app|deploy-nginx|fla)' | xargs -r docker rmi -f 2>/dev/null
else
  echo ">> 镜像已保留 (如需连镜像一起删: sudo bash uninstall.sh --images)"
fi
echo "完成。"
