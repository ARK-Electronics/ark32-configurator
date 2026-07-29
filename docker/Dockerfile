# Local docker-compose image (aligned with root Dockerfile for Sevalla)
FROM node:22-bookworm-slim AS base
WORKDIR /usr/src/app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

FROM base AS prerelease
WORKDIR /usr/src/app

ARG DATABASE_URL
ENV CI=true \
    YARN_ENABLE_INLINE_BUILDS=true \
    NODE_ENV=production \
    REDIS_HOST=cache \
    DATABASE_URL="${DATABASE_URL:-mysql://am32:am32password@mariadb:3306/am32}"

COPY package.json yarn.lock .yarnrc.yml ./
RUN corepack enable \
  && yarn install --immutable

COPY . .
RUN yarn run build

FROM base AS runner
WORKDIR /usr/src/app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    NITRO_HOST=0.0.0.0 \
    REDIS_HOST=cache \
    PORT=3000

COPY --from=prerelease /usr/src/app/.output ./.output
COPY --from=prerelease /usr/src/app/node_modules ./node_modules
COPY --from=prerelease /usr/src/app/package.json ./package.json
COPY --from=prerelease /usr/src/app/prisma ./prisma
COPY --from=prerelease /usr/src/app/prisma.config.ts ./prisma.config.ts

EXPOSE 3000
USER node

ENTRYPOINT ["node", ".output/server/index.mjs"]
