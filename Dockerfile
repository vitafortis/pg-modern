# syntax=docker/dockerfile:1
# Build once on the runner's native platform: the output is plain JS and the
# production dependencies have no native code, so every target arch can reuse it
# (no slow, flaky QEMU emulation during the build).
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod

FROM node:24-alpine
LABEL org.opencontainers.image.source=https://github.com/vitafortis/pg-modern
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    PGM_DATA_DIR=/data \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
# CSV imports upload up to PGM_IMPORT_MAX_MB (50 MB by default); the server's default body limit is 512 KB.
ENV BODY_SIZE_LIMIT=64M
# Database backups shell out to the client tools. pg_dump must be at least as new as
# the server (18 dumps and restores 9.2–18); the MariaDB client provides mariadb-dump
# and mariadb, which also back up MySQL (the connector's caching_sha2_password plugin is
# needed for MySQL 8+ logins). tzdata lets TZ set the schedules' time zone.
RUN apk add --no-cache postgresql18-client mariadb-client mariadb-connector-c tzdata
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "build"]
