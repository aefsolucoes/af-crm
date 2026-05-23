FROM node:20-alpine
WORKDIR /app

COPY package*.json ./
COPY apps/api/package.json ./apps/api/
RUN npm install --workspace=apps/api

COPY apps/api ./apps/api
COPY apps/api/prisma ./apps/api/prisma

RUN npm run build --workspace=apps/api
RUN npx --prefix apps/api prisma generate

EXPOSE 3001
CMD ["node", "apps/api/dist/index.js"]
