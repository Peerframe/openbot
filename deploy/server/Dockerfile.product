FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS product-node
RUN corepack enable npm && corepack prepare npm@10.9.9 --activate && test "$(npm --version)" = "10.9.9"
WORKDIR /workspace

FROM product-node AS product-projection
COPY package-lock.json ./
COPY scripts/node-linux-release.mjs ./scripts/node-linux-release.mjs
COPY deploy/server/product-node-project.mjs ./deploy/server/product-node-project.mjs
COPY packages/python-node-runtime/package.json ./packages/python-node-runtime/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN node deploy/server/product-node-project.mjs /workspace /runtime runtime \
 && node deploy/server/product-node-project.mjs /workspace /build build

FROM product-node AS product-build
COPY --from=product-projection /build/ ./
RUN npm ci --ignore-scripts --audit=false --fund=false
COPY tsconfig.base.json ./
COPY packages/db/src/ ./packages/db/src/
COPY packages/db/tsconfig.json ./packages/db/tsconfig.json
COPY packages/domain/src/ ./packages/domain/src/
COPY packages/domain/tsconfig.json ./packages/domain/tsconfig.json
COPY packages/protocol/src/ ./packages/protocol/src/
COPY packages/protocol/tsconfig.json ./packages/protocol/tsconfig.json
COPY apps/web/src/ ./apps/web/src/
COPY apps/web/index.html apps/web/vite.config.ts apps/web/tsconfig.json ./apps/web/
COPY apps/desktop/resources/openbot-icon.png ./apps/desktop/resources/openbot-icon.png
RUN node_modules/.bin/tsc -p packages/db/tsconfig.json \
 && node_modules/.bin/tsc -p packages/protocol/tsconfig.json \
 && node_modules/.bin/tsc -p packages/domain/tsconfig.json \
 && node_modules/.bin/tsc --noEmit -p apps/web/tsconfig.json \
 && cd apps/web && ../../node_modules/.bin/vite build

FROM product-node AS product-node-dependencies
COPY --from=product-projection /runtime/ ./
RUN npm ci --omit=dev --ignore-scripts --audit=false --fund=false

FROM python:3.12.13-slim-bookworm@sha256:4766d8b510c428e595d74b9cc5bbb2fae8e26316fffb4adc89908d79aacd58a2 AS product-python
FROM product-python AS product-python-dependencies
WORKDIR /workspace
COPY apps/server-python/requirements-worker.lock apps/server-python/requirements.lock apps/server-python/requirements.txt apps/server-python/requirements-dev.txt ./apps/server-python/
COPY apps/server-python/scripts/verify_environment.py ./apps/server-python/scripts/verify_environment.py
RUN python -m venv /opt/openbot/venv \
 && /opt/openbot/venv/bin/python -I -B -m pip --isolated install --only-binary=:all: --no-deps --no-cache-dir --disable-pip-version-check --index-url https://pypi.org/simple -r apps/server-python/requirements-worker.lock \
 && /opt/openbot/venv/bin/python -I -B -m pip check \
 && /opt/openbot/venv/bin/python -I -B apps/server-python/scripts/verify_environment.py --worker

FROM product-python AS runtime-product
WORKDIR /workspace
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 NODE_ENV=production
ENV OPENBOT_CONTROL_AUTHORITY=product OPENBOT_CONTROL_HOST=0.0.0.0 OPENBOT_CONTROL_PORT=3001
ENV OPENBOT_CONTROL_OBJECT_ROOT=/var/lib/openbot/objects OPENBOT_CONTROL_ARTIFACT_ROOT=/var/lib/openbot/artifacts OPENBOT_CONTROL_MODEL_DIRECTORY=/var/lib/openbot/model
ENV OPENBOT_CONTROL_NODE_EXECUTABLE=/usr/local/bin/node OPENBOT_CONTROL_NODE_MODULE_ROOT=/workspace/node_modules OPENBOT_CONTROL_WEB_ROOT=/workspace/apps/web/dist
RUN groupadd --gid 1000 openbot && useradd --uid 1000 --gid openbot --no-create-home --shell /usr/sbin/nologin openbot \
 && install -d -o openbot -g openbot -m 0700 /var/lib/openbot /var/lib/openbot/objects /var/lib/openbot/artifacts /var/lib/openbot/model
COPY --from=product-node /usr/local/bin/node /usr/local/bin/node
COPY --from=product-node /usr/local/LICENSE /usr/share/doc/openbot/NODE_LICENSE
COPY --from=product-python-dependencies /opt/openbot/venv/ /opt/openbot/venv/
COPY --from=product-python-dependencies /workspace/apps/server-python/ ./apps/server-python/
COPY --from=product-node-dependencies /workspace/ ./
COPY --from=product-build /workspace/packages/db/dist/ ./packages/db/dist/
COPY --from=product-build /workspace/apps/web/dist/ ./apps/web/dist/
COPY packages/db/migrations/ ./packages/db/migrations/
COPY apps/server-python/src/ ./apps/server-python/src/
COPY apps/server-python/scripts/serve.py ./apps/server-python/scripts/serve.py
COPY apps/agent-runtime-python/src/ ./apps/agent-runtime-python/src/
COPY deploy/server/product-entry.py deploy/server/product-migrate.mjs deploy/server/product-preflight.mjs deploy/server/product-health.py ./deploy/server/
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY apps/desktop/resources/python-notices/ /usr/share/doc/openbot/python-notices/
RUN test "$(node --version)" = "v24.21.0" \
 && /opt/openbot/venv/bin/python -I -B -c 'import sys; assert sys.version_info[:3] == (3,12,13)' \
 && /opt/openbot/venv/bin/python -I -B apps/server-python/scripts/verify_environment.py --worker \
 && node deploy/server/product-preflight.mjs
USER 1000:1000
EXPOSE 3001
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=5s --timeout=3s --start-period=30s --retries=12 CMD ["/opt/openbot/venv/bin/python", "-I", "-B", "deploy/server/product-health.py"]
CMD ["/opt/openbot/venv/bin/python", "-I", "-B", "deploy/server/product-entry.py"]
