FROM oven/bun:1.3.14-debian

RUN apt-get update \
  && apt-get install -y --no-install-recommends docker.io \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY deploy/deploy-agent.ts /app/deploy-agent.ts

CMD ["bun", "/app/deploy-agent.ts"]
