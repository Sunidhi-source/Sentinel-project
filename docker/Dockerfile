FROM node:20-alpine AS base
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY gateway ./gateway
COPY examples ./examples

ENV PORT=8080
EXPOSE 8080

CMD ["node", "gateway/server.js"]
