ARG RUNTIME_BASE_IMAGE=ghcr.io/alexgetmancom/alexgetman-media-processor:runtime-base
FROM ${RUNTIME_BASE_IMAGE}

WORKDIR /app
COPY deploy/media-processor/server.ts deploy/media-processor/service.ts deploy/media-processor/story-encode.ts /app/deploy/media-processor/
COPY shared/serial-queue.ts /app/shared/serial-queue.ts

EXPOSE 8787
CMD ["bun", "run", "/app/deploy/media-processor/server.ts"]
