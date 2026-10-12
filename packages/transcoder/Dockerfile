# Build context: the repository root (see TranscoderStack).
FROM node:22.22.0-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/transcoder/package.json packages/transcoder/
RUN pnpm install --frozen-lockfile --filter @darkrelay/transcoder...
COPY packages/core packages/core
COPY packages/transcoder packages/transcoder
RUN pnpm --filter @darkrelay/transcoder build

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
