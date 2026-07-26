FROM oven/bun:1.3.14-debian

# VAAPI needs Intel's iHD driver in the image in addition to the /dev/dri
# device supplied by compose.  The remote VM-106 executor is intentionally
# hardware-only; local execution remains the explicit CPU provider.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg intel-media-va-driver \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.ts service.ts serial-queue.ts story-encode.ts /app/

EXPOSE 8787
CMD ["bun", "run", "/app/server.ts"]
