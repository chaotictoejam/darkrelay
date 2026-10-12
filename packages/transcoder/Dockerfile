# Build context: the repository root (see TranscoderStack).
FROM node:22.22.0-bookworm-slim AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
# Every workspace manifest, so npm ci can check the lockfile; only two get installed.
COPY packages/cli/package.json packages/cli/
COPY packages/core/package.json packages/core/
COPY packages/dashboard/package.json packages/dashboard/
COPY packages/functions/package.json packages/functions/
COPY packages/infra/package.json packages/infra/
COPY packages/transcoder/package.json packages/transcoder/
RUN npm ci --workspace @darkrelay/transcoder --workspace @darkrelay/core --include-workspace-root=false
COPY packages/core packages/core
COPY packages/transcoder packages/transcoder
RUN npm run build --workspace @darkrelay/transcoder

FROM node:22.22.0-bookworm-slim
# Debian's ffmpeg includes libx264, libmp3lame and the native AAC encoder.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /repo/packages/transcoder/dist/main.mjs ./main.mjs
RUN mkdir -p /work && chown node:node /work
USER node
ENTRYPOINT ["node", "/app/main.mjs"]
