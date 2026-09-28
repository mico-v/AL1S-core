# syntax=docker/dockerfile:1.7

ARG NODE_BASE_IMAGE=node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f

FROM ${NODE_BASE_IMAGE} AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@10.29.2 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json tsconfig.build.json ./
COPY patches ./patches
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM ${NODE_BASE_IMAGE} AS runtime

ENV NODE_ENV=production
ENV MATRIX_BRIDGE_LISTEN_HOST=0.0.0.0
ENV MATRIX_BRIDGE_DATA_FILE=/var/lib/al1s/state.json

WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

RUN install -d -o node -g node /var/lib/al1s

USER node

EXPOSE 29328

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.MATRIX_BRIDGE_PORT || '29328') + '/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "dist/matrix-bridge.js"]
