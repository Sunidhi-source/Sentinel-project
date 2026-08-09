FROM node:20-alpine AS base
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY gateway ./gateway
COPY examples ./examples

EXPOSE 4000

CMD ["node", "src/dashboard/server.js"]