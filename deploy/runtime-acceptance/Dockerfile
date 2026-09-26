# Disposable acceptance fixture, not the production Server image.
FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS node
FROM python:3.12.13-slim-bookworm@sha256:6e13e65c55e33adf203d77ee371cf8bf5d81bd4902ef07565721f46bf44917af
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
  && npm install --global --ignore-scripts npm@10.9.9 \
  && test "$(node --version)" = "v24.21.0" \
  && test "$(npm --version)" = "10.9.9"
WORKDIR /workspace/apps/agent-runtime-python
COPY apps/agent-runtime-python/requirements.lock ./requirements.lock
RUN python -m venv .venv \
  && .venv/bin/python -m pip --isolated install --no-cache-dir --disable-pip-version-check \
       --index-url https://pypi.org/simple -r requirements.lock
WORKDIR /workspace/apps/server-python
COPY apps/server-python/requirements.lock ./requirements.lock
RUN python -m venv .venv \
  && .venv/bin/python -m pip --isolated install --no-cache-dir --disable-pip-version-check \
       --index-url https://pypi.org/simple -r requirements.lock
WORKDIR /workspace
COPY . .
ENV TURBO_TELEMETRY_DISABLED=1
RUN npm ci --ignore-scripts --audit=false \
  && node node_modules/turbo/bin/turbo run build --filter=@openbot/node^... \
  && chown -R 1000:1000 /workspace
USER 1000:1000
CMD ["sh", "deploy/runtime-acceptance/check.sh"]
