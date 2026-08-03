ARG RUNTIME_BASE_IMAGE
FROM ${RUNTIME_BASE_IMAGE}

WORKDIR /app
COPY server.ts service.ts serial-queue.ts story-encode.ts /app/

EXPOSE 8787
CMD ["bun", "run", "/app/server.ts"]
