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
COPY packages/brain/package.json packages/brain/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY packages packages
COPY apps/api apps/api
RUN pnpm --filter @operaiq/api... build
RUN pnpm --filter @operaiq/api deploy --legacy --prod --no-optional /out
RUN find /out -type f \( -name '*.map' -o -name '*.ts' -o -name '*.tsx' -o -name '*.md' \) -delete \
  && find /out -type d \( -name test -o -name tests -o -name __tests__ -o -name docs -o -name doc -o -name example -o -name examples -o -name benchmark -o -name benchmarks \) -prune -exec rm -rf '{}' + \
  && rm -rf /out/src /out/Dockerfile /out/tsconfig.json

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=nonroot:nonroot /out ./
EXPOSE 3001
CMD ["dist/server.js"]
