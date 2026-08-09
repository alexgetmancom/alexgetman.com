ARG RUNTIME_BASE_IMAGE=ghcr.io/alexgetmancom/alexgetman-media-processor:runtime-base
FROM ${RUNTIME_BASE_IMAGE}

WORKDIR /app
COPY server.ts service.ts serial-queue.ts story-encode.ts /app/

EXPOSE 8787
CMD ["bun", "run", "/app/server.ts"]
