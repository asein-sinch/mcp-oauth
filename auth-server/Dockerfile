# ---- build stage ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
# Token minter, usable in jwt mode: `docker run --rm --env-file auth.env <image> node mint-token.mjs [email]`
COPY mint-token.mjs ./
EXPOSE 8080
CMD ["node", "dist/server.js"]
