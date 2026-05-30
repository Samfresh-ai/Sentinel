FROM node:22-slim AS deps
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 make g++ pkg-config libkrb5-dev \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/splunk-brain/package.json packages/splunk-brain/package.json
COPY packages/splunk-mcp/package.json packages/splunk-mcp/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
ARG NEXT_PUBLIC_API_URL=
ARG NEXT_PUBLIC_SPLUNK_DASHBOARD_URL=/splunk
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_SPLUNK_DASHBOARD_URL=${NEXT_PUBLIC_SPLUNK_DASHBOARD_URL}
COPY packages packages
COPY apps/api apps/api
COPY apps/web apps/web
RUN pnpm --filter @sentinel/api... build
RUN pnpm --filter @sentinel/web build
RUN mkdir -p /out/web/apps/web/.next \
  && cp -R apps/web/.next/standalone/. /out/web/ \
  && cp -R apps/web/.next/static /out/web/apps/web/.next/static \
  && cp -R apps/web/public /out/web/apps/web/public

FROM node:22-slim AS runner
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /out/web ./web
COPY --chown=node:node apps/api/docker/sentinel-combined-server.mjs ./server.mjs
USER node
EXPOSE 3001
CMD ["node", "server.mjs"]
