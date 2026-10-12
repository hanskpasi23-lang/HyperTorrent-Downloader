# ==============================================================================
# HyperTorrent — Production Cloud Seedbox Dockerfile
# Based on Debian Bookworm Slim (glibc) for 100% stability with native networking
# ==============================================================================

FROM node:20-bookworm-slim

# Install system build dependencies and curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production

# Copy application source code and configuration manifests
COPY server/ ./server/
COPY public/ ./public/
COPY *.json ./

# Ensure download directory and session file exist
RUN mkdir -p /app/downloads && touch /app/session.json

# Environment configuration & Memory tuning
ENV NODE_ENV=production
ENV PORT=3000
ENV TORRENT_PORT=6881
ENV DOWNLOAD_DIR=/app/downloads
ENV NODE_OPTIONS="--max-old-space-size=1536"
ENV MAX_ACTIVE_TORRENTS=4
ENV MAX_CONNS_PER_TORRENT=35
ENV AUTO_PAUSE_COMPLETED=true

# Expose Web Dashboard (3000) and BitTorrent Wire Port (6881 TCP/UDP)
EXPOSE 3000
EXPOSE 6881
EXPOSE 6881/udp

# Healthcheck to verify web service availability
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://127.0.0.1:3000/api/trackers/live || exit 1

# Start HyperTorrent Daemon with GC hook for memory watchdog
CMD ["node", "--expose-gc", "server/index.js"]
