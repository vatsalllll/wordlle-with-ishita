FROM node:24-alpine
WORKDIR /app
COPY package.json server.mjs ./
COPY data ./data
COPY public ./public
RUN mkdir /state && chown node:node /state
ENV NODE_ENV=production PORT=3000 DB_PATH=/state/wordbloom.sqlite
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
