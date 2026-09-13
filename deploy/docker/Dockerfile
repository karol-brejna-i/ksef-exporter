# syntax=docker/dockerfile:1.7
#
# Multi-stage image for KSeF Exporter. Build context MUST be the repo root
# (all COPY paths below are repo-root-relative), e.g.:
#
#   docker build -f deploy/docker/Dockerfile --target api -t ksef-api .
#   docker build -f deploy/docker/Dockerfile --target web -t ksef-web .
#
# See design/DOCKER_DEPLOYMENT_PLAN.md §5 for the design this implements.

##############################################################################
# build — compiles the backend (tsc -> dist/) and the frontend (vite ->
# web/dist/), then produces a production-only node_modules for the api stage.
##############################################################################
FROM node:24.16.0-bookworm-slim AS build

# python3/make/g++ let better-sqlite3 compile from source when no prebuild
# matches this platform/ABI; ca-certificates is needed for corepack/pnpm to
# fetch packages over https. --no-install-recommends + clearing apt lists
# keeps this stage (which is never shipped) from ballooning for no reason.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# pnpm's version comes from package.json's "packageManager" field via
# corepack — never hardcode a pnpm version here. CI=true stops pnpm from
# prompting (it refuses to purge modules dirs without a TTY otherwise) —
# needed below when the prod-only reinstall removes devDependencies.
ENV CI=true
RUN corepack enable \
    && pnpm config set store-dir /pnpm/store

WORKDIR /app

# Copy only the manifests and lockfile first so this layer (and the
# install below) is cached across rebuilds that only touch application
# source. pnpm needs every workspace project's package.json to resolve the
# workspace graph, hence web/package.json even though web/'s source isn't
# copied yet.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/package.json

# BuildKit cache mount for the pnpm content-addressable store: reused across
# builds (not just across layers of one build), so an unchanged lockfile
# skips re-downloading packages entirely. Print the resolved store-dir and a
# sample of its contents so the mount's effect is visible in build logs
# rather than assumed.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config get store-dir \
    && pnpm install --frozen-lockfile \
    && echo "pnpm store entries after install:" \
    && ls /pnpm/store | head -5

# Now bring in the sources needed to build, and build both packages. Kept
# after the install layer so editing src/ or web/ never invalidates the
# (much slower) install layer above.
COPY tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle
COPY web ./web

RUN pnpm run build
RUN pnpm --dir web run build

# Reduce node_modules to production dependencies only, scoped to the root
# "ksef-exporter" workspace project so web/'s (dev-only, browser) deps never
# reach the runtime image.
#
# --filter alone adjusts top-level symlinks (so a plain `require("vite")`
# from application code would already fail) but was observed to leave the
# actual devDependency package contents behind inside node_modules/.pnpm
# (pnpm's content-addressable store copy inside this project), unused but
# still physically present and adding ~250MB of dead weight. `pnpm prune
# --prod` afterwards is what actually deletes those unreferenced packages
# from disk; run it unconditionally, not only as an error fallback.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter ksef-exporter \
    && pnpm prune --prod \
    && echo "node_modules size after prod prune:" \
    && du -sh node_modules

# A bare `require("better-sqlite3")` does NOT dlopen the native addon — only
# `new Database(...)` does — so this must actually instantiate a database to
# prove the production node_modules still has a working binding for this
# platform/ABI after the prod-only reinstall/prune above. If this fails, the
# build fails here rather than at container boot.
RUN node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.pragma('journal_mode'); db.close(); console.log('better-sqlite3 OK:', process.version);"

##############################################################################
# api — runtime image for the Fastify backend.
##############################################################################
FROM node:24.16.0-bookworm-slim AS api

ARG GIT_SHA=unknown
LABEL org.opencontainers.image.revision=$GIT_SHA

WORKDIR /app

# Same base image as the build stage (identical glibc), so the native
# better-sqlite3 binding compiled/verified there stays valid here.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/package.json ./package.json

# src/db/client.ts resolves migrations as "../../drizzle/migrations" relative
# to its own compiled module URL. From /app/dist/db/client.js that must land
# on /app/drizzle/migrations, which the COPY above preserves by keeping
# drizzle/ a sibling of dist/ at the image root.

# /data (the SQLite file) and /backups (snapshot destination) are written by
# the app at runtime under the unprivileged "node" user already present in
# this base image.
RUN mkdir -p /data /backups \
    && chown node:node /data /backups

USER node

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/ksef-exporter.sqlite \
    TZ=Europe/Warsaw

EXPOSE 3000

# No curl in the slim image, hence a node -e probe. Written against GET
# /health regardless of whether that route exists yet in this checkout (a
# concurrent change is adding it) — until it does, this simply fails, which
# is the correct signal.
HEALTHCHECK --interval=30s --timeout=5s --retries=5 --start-period=20s \
    CMD ["node", "-e", "require('http').get('http://127.0.0.1:3000/health',(r)=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"]

CMD ["node", "dist/api/main.js"]

##############################################################################
# web — nginx serving the built SPA and proxying /api/ to the api service.
##############################################################################
FROM nginx:1.29-alpine AS web

# Remove the stock welcome-page vhost so it can't shadow app.conf (both would
# otherwise listen on :80 with no server_name, and load order would decide
# which one answers unmatched requests).
RUN rm -f /etc/nginx/conf.d/default.conf

COPY --from=build /app/web/dist /usr/share/nginx/html

# The official nginx entrypoint runs envsubst over every *.template file
# under /etc/nginx/templates/ at container start, writing the result to
# /etc/nginx/conf.d/app.conf. ${API_UPSTREAM} is provided as a container
# environment variable by the compose service.
COPY deploy/docker/nginx/app.conf.template /etc/nginx/templates/app.conf.template
