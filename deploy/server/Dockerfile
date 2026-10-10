# One reviewed Node runtime owns the Server, parser and Temporal Worker.
FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS product-node
RUN corepack enable npm && corepack prepare npm@10.9.9 --activate && test "$(npm --version)" = "10.9.9"
WORKDIR /workspace

FROM product-node AS product-projection
COPY package-lock.json ./
COPY scripts/production-package-graph.ts ./scripts/production-package-graph.ts
COPY deploy/server/product-node-project.ts ./deploy/server/product-node-project.ts
COPY packages/db/package.json ./packages/db/package.json
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/logging/package.json ./packages/logging/package.json
COPY packages/employee-publisher/package.json ./packages/employee-publisher/package.json
COPY packages/work/package.json ./packages/work/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN node deploy/server/product-node-project.ts /workspace /runtime runtime \
 && node deploy/server/product-node-project.ts /workspace /build build

FROM product-node AS product-build
COPY --from=product-projection /build/ ./
RUN npm ci --ignore-scripts --audit=false --fund=false
COPY tsconfig.base.json ./
COPY packages/db/src/ ./packages/db/src/
COPY packages/db/tsconfig.json ./packages/db/tsconfig.json
COPY packages/protocol/src/ ./packages/protocol/src/
COPY packages/protocol/tsconfig.json ./packages/protocol/tsconfig.json
COPY packages/domain/src/ ./packages/domain/src/
COPY packages/domain/tsconfig.json ./packages/domain/tsconfig.json
COPY packages/logging/src/ ./packages/logging/src/
COPY packages/logging/tsconfig.json ./packages/logging/tsconfig.json
COPY packages/employee-publisher/src/ ./packages/employee-publisher/src/
COPY packages/employee-publisher/tsconfig.json ./packages/employee-publisher/tsconfig.json
COPY packages/work/src/ ./packages/work/src/
COPY packages/work/tsconfig.json ./packages/work/tsconfig.json
COPY apps/server/src/ ./apps/server/src/
COPY apps/server/tsconfig.json ./apps/server/tsconfig.json
COPY apps/web/src/ ./apps/web/src/
COPY apps/web/index.html apps/web/vite.config.ts apps/web/tsconfig.json ./apps/web/
COPY apps/desktop/resources/openbot-icon.png ./apps/desktop/resources/openbot-icon.png
RUN node_modules/.bin/tsc -p packages/db/tsconfig.json \
 && node_modules/.bin/tsc -p packages/protocol/tsconfig.json \
 && node_modules/.bin/tsc -p packages/domain/tsconfig.json \
 && node_modules/.bin/tsc -p packages/logging/tsconfig.json \
 && node_modules/.bin/tsc -p packages/employee-publisher/tsconfig.json \
 && node_modules/.bin/tsc -p packages/work/tsconfig.json \
 && node_modules/.bin/tsc -p apps/server/tsconfig.json \
 && node_modules/.bin/tsc --noEmit -p apps/web/tsconfig.json \
 && cd apps/web && ../../node_modules/.bin/vite build

FROM product-node AS product-node-dependencies
COPY --from=product-projection /runtime/ ./
RUN npm ci --omit=dev --ignore-scripts --audit=false --fund=false

FROM product-node AS runtime-product
ENV NODE_ENV=production
ENV OPENBOT_TS_HOST=0.0.0.0 OPENBOT_TS_PORT=3001
ENV OPENBOT_TS_OBJECT_ROOT=/var/lib/openbot/objects OPENBOT_TS_ARTIFACT_ROOT=/var/lib/openbot/artifacts
ENV OPENBOT_TS_WORK_FILE_ROOT=/var/lib/openbot/artifacts
ENV OPENBOT_CONTROL_WEB_ROOT=/workspace/apps/web/dist
RUN groupmod --new-name openbot node && usermod --login openbot --shell /usr/sbin/nologin node \
 && install -d -o openbot -g openbot -m 0700 /var/lib/openbot /var/lib/openbot/objects /var/lib/openbot/artifacts
COPY --from=product-node-dependencies /workspace/ ./
COPY --from=product-build /workspace/packages/db/dist/ ./packages/db/dist/
COPY --from=product-build /workspace/packages/protocol/dist/ ./packages/protocol/dist/
COPY --from=product-build /workspace/packages/domain/dist/ ./packages/domain/dist/
COPY --from=product-build /workspace/packages/logging/dist/ ./packages/logging/dist/
COPY --from=product-build /workspace/packages/employee-publisher/dist/ ./packages/employee-publisher/dist/
COPY --from=product-build /workspace/packages/work/dist/ ./packages/work/dist/
COPY --from=product-build /workspace/apps/server/dist/ ./apps/server/dist/
COPY --from=product-build /workspace/apps/web/dist/ ./apps/web/dist/
COPY packages/db/migrations/ ./packages/db/migrations/
COPY deploy/server/product-entry.ts deploy/server/product-migrate.ts deploy/server/product-preflight.ts deploy/server/product-health.ts deploy/server/prepare-product.ts deploy/server/legacy-work-preflight.ts ./deploy/server/
COPY LICENSE THIRD_PARTY_NOTICES.md ./
RUN test "$(node --version)" = "v24.21.0" && node deploy/server/product-preflight.ts
USER 1000:1000
EXPOSE 3001
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=5s --timeout=3s --start-period=30s --retries=12 CMD ["node", "deploy/server/product-health.ts"]
CMD ["node", "deploy/server/product-entry.ts"]
