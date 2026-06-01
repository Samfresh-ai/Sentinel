FROM node:22-slim AS deps
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
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
ARG NEXT_PUBLIC_QDRANT_DASHBOARD_URL=
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_QDRANT_DASHBOARD_URL=${NEXT_PUBLIC_QDRANT_DASHBOARD_URL}
COPY apps/web apps/web
RUN pnpm --filter @sentinel/web build

FROM node:22-slim AS runner
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=10000
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static apps/web/.next/static
COPY --from=build /app/apps/web/public apps/web/public
EXPOSE 10000
CMD ["node", "apps/web/server.js"]
