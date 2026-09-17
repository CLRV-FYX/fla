# FLA - 统一入口 nginx (配置打包进镜像, 避免 SELinux bind-mount 问题)
FROM nginx:alpine
COPY deploy/nginx-app.conf /etc/nginx/conf.d/fla-full.conf
COPY deploy/nginx-app.lite.conf /etc/nginx/conf.d/fla-lite.conf
COPY deploy/nginx-entrypoint.sh /entrypoint-fla.sh
RUN chmod +x /entrypoint-fla.sh && rm -f /etc/nginx/conf.d/default.conf
ENTRYPOINT ["/entrypoint-fla.sh"]
