#!/bin/sh
# FLA nginx 入口: 按 FLA_MODE 选择配置; 打印模式并校验配置, 便于诊断
set -e
rm -f /etc/nginx/conf.d/default.conf
if [ "${FLA_MODE:-full}" = "lite" ]; then
  cp /etc/nginx/conf.d/fla-lite.conf /etc/nginx/conf.d/default.conf
else
  cp /etc/nginx/conf.d/fla-full.conf /etc/nginx/conf.d/default.conf
fi
echo "[nginx] FLA_MODE=${FLA_MODE:-full} | 配置: /etc/nginx/conf.d/default.conf"
nginx -t
exec nginx -g 'daemon off;'
