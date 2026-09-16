FROM node:22-trixie-slim
# Debian's calibre package provides ebook-convert; it runs headless through
# Qt's offscreen platform, so no X server is needed.
RUN apt-get update \
  && apt-get install -y --no-install-recommends calibre tzdata \
  && rm -rf /var/lib/apt/lists/*
ENV QT_QPA_PLATFORM=offscreen EBOOK_ROOT=/ebooks CACHE_DIR=/cache PORT=8790
WORKDIR /app
COPY package.json ./
COPY src ./src
EXPOSE 8790
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --start-interval=2s \
  CMD node -e "fetch('http://127.0.0.1:8790/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "src/server.js"]
