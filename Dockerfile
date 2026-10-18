FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

# Dependências primeiro para aproveitar o cache de camadas
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Código da aplicação e migrations (ver .dockerignore)
COPY . .

USER node

EXPOSE 3000

CMD ["node", "src/server.js"]
