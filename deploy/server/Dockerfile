FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS base

FROM base AS toolchain
ENV TURBO_TELEMETRY_DISABLED=1
RUN corepack enable npm \
  && corepack prepare npm@10.9.9 --activate \
  && test "$(npm --version)" = "10.9.9"
WORKDIR /workspace

FROM toolchain AS pruner
COPY . .
RUN npm ci --ignore-scripts --audit=false
RUN npm exec -- turbo prune @openbot/server --docker --out-dir=/pruned

FROM toolchain AS build
COPY --from=pruner /pruned/json/ ./
RUN npm ci --ignore-scripts --audit=false
COPY --from=pruner /pruned/full/ ./
COPY --from=pruner /workspace/tsconfig.base.json ./tsconfig.base.json
RUN npm exec -- turbo run build --filter=@openbot/server...

FROM toolchain AS production-dependencies
COPY --from=pruner /pruned/json/ ./
# Keep an apps/server/node_modules directory even when npm hoists every Server
# production dependency: Docker COPY fails on a missing source, and workspace
# installs may nest packages here when another workspace pins a different major.
RUN npm ci --omit=dev --ignore-scripts --audit=false \
  && mkdir -p apps/server/node_modules

FROM base AS runtime-node
ENV NODE_ENV=production
ENV OPENBOT_OBJECT_STORE_PATH=/var/lib/openbot/objects
WORKDIR /workspace

RUN install -d --owner=node --group=node --mode=0700 /var/lib/openbot/objects
RUN install -d --owner=node --group=node --mode=0700 /var/lib/openbot/model

COPY --from=production-dependencies --chown=node:node /workspace/node_modules ./node_modules
# Nested Server workspace production closure (omit=dev). Root node_modules alone is
# not enough when npm nests a Server production dependency under apps/server.
COPY --from=production-dependencies --chown=node:node /workspace/apps/server/node_modules ./apps/server/node_modules
COPY --from=build --chown=node:node /workspace/package.json ./package.json
COPY --from=build --chown=node:node /workspace/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /workspace/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /workspace/packages/config/package.json ./packages/config/package.json
COPY --from=build --chown=node:node /workspace/packages/config/dist ./packages/config/dist
COPY --from=build --chown=node:node /workspace/packages/db/package.json ./packages/db/package.json
COPY --from=build --chown=node:node /workspace/packages/db/dist ./packages/db/dist
COPY --from=build --chown=node:node /workspace/packages/db/migrations ./packages/db/migrations
COPY --from=build --chown=node:node /workspace/packages/domain/package.json ./packages/domain/package.json
COPY --from=build --chown=node:node /workspace/packages/domain/dist ./packages/domain/dist
COPY --from=build --chown=node:node /workspace/packages/logging/package.json ./packages/logging/package.json
COPY --from=build --chown=node:node /workspace/packages/logging/dist ./packages/logging/dist
COPY --from=build --chown=node:node /workspace/packages/policy/package.json ./packages/policy/package.json
COPY --from=build --chown=node:node /workspace/packages/policy/dist ./packages/policy/dist
COPY --from=build --chown=node:node /workspace/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build --chown=node:node /workspace/packages/protocol/dist ./packages/protocol/dist
COPY --from=build --chown=node:node /workspace/packages/windows-secret-acl/package.json ./packages/windows-secret-acl/package.json
COPY --from=build --chown=node:node /workspace/packages/windows-secret-acl/dist ./packages/windows-secret-acl/dist
COPY --chown=node:node deploy/server/healthcheck.mjs ./deploy/server/healthcheck.mjs

USER node
EXPOSE 3001
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD ["node", "deploy/server/healthcheck.mjs"]
CMD ["node", "apps/server/dist/index.js"]

# Opt-in Python runtime. Both stages use the same interpreter and absolute venv path.
FROM python:3.12.13-slim-bookworm@sha256:4766d8b510c428e595d74b9cc5bbb2fae8e26316fffb4adc89908d79aacd58a2 AS python-base
FROM python-base AS python-dependencies
WORKDIR /workspace/apps/agent-runtime-python
COPY apps/agent-runtime-python/requirements-runtime.lock ./requirements-runtime.lock
RUN python -m venv .venv \
  && .venv/bin/python -m pip --isolated install --only-binary=:all: --no-cache-dir \
       --disable-pip-version-check --index-url https://pypi.org/simple -r requirements-runtime.lock \
  && .venv/bin/python -m pip check
COPY apps/agent-runtime-python/requirements*.txt apps/agent-runtime-python/requirements.lock ./
COPY apps/agent-runtime-python/scripts/verify_environment.py ./scripts/verify_environment.py
RUN .venv/bin/python -I scripts/verify_environment.py --profile runtime

FROM python-base AS runtime-python
ENV NODE_ENV=production
ENV OPENBOT_AGENT_RUNTIME=python
ENV OPENBOT_OBJECT_STORE_PATH=/var/lib/openbot/objects
WORKDIR /workspace/scripts
WORKDIR /workspace
RUN groupadd --gid 1000 node \
  && useradd --uid 1000 --gid node --create-home --shell /bin/sh node \
  && install -d --owner=node --group=node --mode=0700 /var/lib/openbot/objects /var/lib/openbot/model
COPY --from=base /usr/local/bin/node /usr/local/bin/node
COPY --from=runtime-node /workspace/ ./
COPY --from=python-dependencies /workspace/apps/agent-runtime-python/ ./apps/agent-runtime-python/
COPY apps/agent-runtime-python/src/ ./apps/agent-runtime-python/src/
COPY apps/agent-runtime-python/scripts/run-worker.py ./apps/agent-runtime-python/scripts/run-worker.py
USER node
EXPOSE 3001
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD ["node", "deploy/server/healthcheck.mjs"]
CMD ["node", "apps/server/dist/index.js"]

# Keep the unqualified build and existing Compose file on the established default.
FROM runtime-node AS runtime
