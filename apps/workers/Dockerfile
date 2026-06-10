FROM node:20-alpine AS builder

WORKDIR /usr/src/app

COPY package*.json tsconfig.base.json ./
COPY packages/db/package*.json ./packages/db/
COPY packages/types/package*.json ./packages/types/
COPY apps/workers/package*.json ./apps/workers/

RUN npm ci

COPY packages/db/ ./packages/db/
RUN npm run generate -w packages/db

COPY packages/types/ ./packages/types/
COPY apps/workers/ ./apps/workers/

RUN npm run build -w packages/db
RUN npm run build -w packages/types
RUN npm run build -w apps/workers

FROM node:20-alpine

WORKDIR /usr/src/app

COPY package*.json ./
COPY packages/db/package*.json ./packages/db/
COPY packages/types/package*.json ./packages/types/
COPY apps/workers/package*.json ./apps/workers/

RUN npm ci --omit=dev

COPY --from=builder /usr/src/app/packages/db/dist ./packages/db/dist
COPY --from=builder /usr/src/app/packages/db/prisma ./packages/db/prisma
COPY --from=builder /usr/src/app/packages/db/node_modules/.prisma ./packages/db/node_modules/.prisma
COPY --from=builder /usr/src/app/packages/db/node_modules/@prisma/client ./packages/db/node_modules/@prisma/client

COPY --from=builder /usr/src/app/packages/types/dist ./packages/types/dist
COPY --from=builder /usr/src/app/apps/workers/dist ./apps/workers/dist

ENV NODE_ENV=production

CMD ["npm", "start", "-w", "apps/workers"]
