# ---- build stage ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
COPY ui ./ui
RUN npm run build

# ---- runtime stage ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
# Default auth mode baked into the image (jwt | static-token | none). Overridable at run time
# with `-e AUTH_MODE=...`. The published image variants set this via --build-arg.
ARG AUTH_MODE=jwt
ENV AUTH_MODE=${AUTH_MODE}
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 8090
CMD ["node", "dist/server.js"]
