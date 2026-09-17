# FLA (FYX Lesson All) - 生产镜像 (Python + LibreOffice + ffmpeg + 中文字体)
FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 TZ=Asia/Hong_Kong

RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-impress libreoffice-writer libreoffice-calc \
      fontconfig tzdata \
      fonts-noto-cjk fonts-liberation fonts-liberation2 \
      fonts-lxgw-wenkai fonts-crosextra-carlito fonts-crosextra-caladea \
      ffmpeg \
    && rm -rf /var/lib/apt/lists/*
# v1.26: ffmpeg — 非浏览器通用视频格式(mkv/wmv/avi/mov...)自动转码 mp4 (开源离线)

# 常见商业字体 -> 开源字体替换规则(保证不出现方框)
COPY deploy/fonts/30-edu-substitutions.conf /etc/fonts/conf.d/30-edu-substitutions.conf

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server ./server
COPY web ./web

ENV FLA_DATA_DIR=/data
RUN mkdir -p /data
VOLUME /data
EXPOSE 8000

HEALTHCHECK --interval=60s --timeout=10s --retries=5 \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=8)" || exit 1

CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
