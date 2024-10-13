FROM node:current-alpine AS build

# Make pnpm available
RUN npm i -g pnpm

# working directory for the build
WORKDIR /build

# Copy package configs into working Directory
COPY ./package.json ./pnpm-lock.yaml ./tsconfig.json /build/

# Install required packages
RUN pnpm i

# Copy src files into Working Directory
COPY ./src /build/src

# Compile the project
RUN npx tsc

# Copy built artifacts and dependencies into a minimal release image
FROM node:current-alpine AS release

LABEL Description="Project for aggregating prometheus exporter metrics."

# Create Directory for the Container
WORKDIR /fs

COPY --from=build /build/node_modules node_modules
COPY --from=build /build/dist dist
COPY --from=build /build/package.json package.json

# Runs on container start
CMD node ./dist/sock.js
