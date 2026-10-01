# HFA Time Governance — the worker image (Azure Container Apps, or any host
# that runs a container). Build: docker build -t time-governance .
# Applies migrations, then runs the scheduler. No ports.
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

WORKDIR /app

# The pnpm version is pinned by package.json's packageManager field.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && corepack install \
 && pnpm install --frozen-lockfile --prod \
 && pnpm store prune

COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY templates ./templates

# Run as the image's unprivileged user; it needs pnpm's corepack cache too.
RUN mkdir -p /home/node/.cache && cp -r /root/.cache/node /home/node/.cache/ 2>/dev/null || true \
 && chown -R node:node /home/node/.cache
USER node

# Migrate, then exec the worker so it is PID 1 and receives SIGTERM directly
# (behind `pnpm start` the signal never reached it, so a job in flight could not
# finish its graceful drain).
CMD ["sh", "-c", "node --import tsx scripts/migrate.ts && exec node --import tsx src/worker.ts"]
