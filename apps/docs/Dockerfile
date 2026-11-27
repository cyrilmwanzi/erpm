FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS deps
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/docs/package.json ./apps/docs/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/sdk/package.json ./packages/sdk/package.json
COPY packages/typescript-config/package.json ./packages/typescript-config/package.json

RUN pnpm install --frozen-lockfile

FROM deps AS builder
WORKDIR /app

COPY . .

RUN pnpm --filter @scace/db db:generate && pnpm --filter @scace/db build && pnpm --filter @scace/docs build

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV SCACE_API_URL=http://api:3000

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 scace

COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/docs/package.json ./apps/docs/package.json
COPY --from=builder /app/apps/docs/node_modules ./apps/docs/node_modules
COPY --from=builder /app/apps/docs/dist ./apps/docs/dist
COPY --from=builder /app/apps/docs/server.mjs ./apps/docs/server.mjs

WORKDIR /app/apps/docs
USER scace

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.mjs"]
