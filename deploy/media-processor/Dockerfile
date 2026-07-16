FROM oven/bun:1.3.14-debian

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.ts /app/server.ts

EXPOSE 8787
CMD ["bun", "run", "/app/server.ts"]
