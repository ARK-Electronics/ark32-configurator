# Production image for Sevalla / container hosts (Nuxt 3 + Prisma 7)
FROM node:22-bookworm-slim AS base
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

FROM base AS build
WORKDIR /app

ENV CI=true \
    NODE_ENV=production \
    YARN_ENABLE_INLINE_BUILDS=true \
    # prisma generate does not need a live database
    DATABASE_URL=mysql://build:build@127.0.0.1:3306/build

COPY package.json yarn.lock .yarnrc.yml ./
RUN corepack enable \
  && yarn install --immutable

COPY . .
RUN yarn run build

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    NITRO_HOST=0.0.0.0 \
    PORT=3000

# Nitro server + production node_modules (bcrypt, prisma engines, etc.)
COPY --from=build /app/.output ./.output
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts

EXPOSE 3000
USER node

CMD ["node", ".output/server/index.mjs"]
