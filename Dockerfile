# syntax=docker/dockerfile:1.12.1@sha256:93bfd3b68c109427185cd78b4779fc82b484b0b7618e36d0f104d4d801e66d25
#
# Two images from one Dockerfile, both built on the dependency stage below:
#
#   docker build --target web -t frameflow-web .          Next.js standalone server on port 3000
#   docker build --target backend -t frameflow-backend .  Fastify API on port 4000 by default. The same image runs the
#                                                         worker, reconcile and cleanup with another command
#
# Each target builds for linux/amd64 and linux/arm64 from these same lines. The base is a multi-platform index, and npm
# and apt pick each platform's binaries, so nothing here downloads for one architecture.
#
# The syntax line pins the Dockerfile frontend that BuildKit runs, by index digest like NODE_IMAGE below, so a retag of
# docker/dockerfile:1.12 cannot change what a build produces. Bump its tag and digest together, the same way.

# The index digest pins the image of every platform at once. Bump the tag and the digest together, reading the digest
# from 'docker buildx imagetools inspect node:<tag>'.
ARG NODE_IMAGE=node:24.22.2-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d

FROM ${NODE_IMAGE} AS base
WORKDIR /app

# The one dependency stage. It installs the whole lockfile, which the web build needs, and leaves npm's cache in this
# layer, so the backend's production install below reads every package from it instead of the registry.
FROM base AS deps
# Every npm command in this stage and those built on it. CI runs the audit, and the rest is noise in a build log.
ENV NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS web-build
# Build-time only: next build bakes the rewrite destinations into .next/routes-manifest.json, and the running image
# ignores API_ORIGIN. The default is the API's Service in the same namespace.
ARG API_ORIGIN=http://frameflow-api:4000
ENV API_ORIGIN=${API_ORIGIN} \
    NEXT_OUTPUT=standalone \
    NEXT_TELEMETRY_DISABLED=1
COPY . .
# public/ is optional, and an empty one keeps the COPY into the web image valid without it.
RUN mkdir -p public && npm run build

FROM base AS web
LABEL org.opencontainers.image.title="frameflow-web" \
      org.opencontainers.image.description="Frameflow Next.js server (standalone output)"
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# Owned by root, so the server cannot change its own code.
COPY --from=web-build /app/.next/standalone ./
COPY --from=web-build /app/.next/static ./.next/static
COPY --from=web-build /app/public ./public
# The one path the server writes. Mount an emptyDir here, and one at /tmp, to run with a read-only root filesystem.
RUN install -d -o node -g node .next/cache
# The image's node user, by number so that Kubernetes runAsNonRoot can verify it.
USER 1000:1000
EXPOSE 3000
CMD ["node", "server.js"]

FROM deps AS backend-deps
RUN npm ci --omit=dev --offline

FROM base AS backend
LABEL org.opencontainers.image.title="frameflow-backend" \
      org.opencontainers.image.description="Frameflow API, Hatchet worker and maintenance commands, with FFmpeg"
# Debian's own builds, from the release the base image pins. Their versions are not pinned, so a rebuild takes the
# release's security updates, and a version pin would fail the build once the mirrors drop that version.
# hadolint ignore=DL3008
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg tini \
  && rm -rf /var/lib/apt/lists/*
# HOST: listen beyond the container's loopback. DOTENV_CONFIG_QUIET: the image has no .env, and settings come from the
# environment, so dotenv need not announce that it loaded nothing.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    DOTENV_CONFIG_QUIET=true
COPY --from=backend-deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY migrations ./migrations
COPY src ./src
# The default DATABASE_PATH and WORKER_TEMP_DIR live here. Mount a volume over each, or point those variables at
# volumes, and an emptyDir at /tmp, where tsx caches compiled modules, to run with a read-only root filesystem.
RUN install -d -o node -g node data .worker-tmp
USER 1000:1000
EXPOSE 4000
ENTRYPOINT ["/usr/bin/tini", "--"]
# The API. The worker is node --import tsx src/worker.ts, and reconcile and cleanup run src/reconcile.ts and
# src/cleanup.ts the same way.
CMD ["node", "--import", "tsx", "src/api/server.ts"]
