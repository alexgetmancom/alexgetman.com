FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip rsync curl bash tzdata ca-certificates unzip ffmpeg \
    && pip3 install --break-system-packages --no-cache-dir fastapi uvicorn \
    && curl -fsSL https://bun.sh/install | bash \
    && mv /root/.bun/bin/bun /usr/local/bin/bun \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY posting_core /app/posting_core
COPY site_feed /app/site_feed

CMD ["python3", "-u", "-m", "site_feed.app", "serve"]
