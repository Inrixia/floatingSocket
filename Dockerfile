FROM node:current-alpine AS build

# working directory for the build
WORKDIR ${HOME}

# Copy package configs into working Directory
COPY ./package.json ./package-lock.json ./tsconfig.json ${HOME}/

# Install required packages
RUN npm ci --omit-dev

# Copy src files into Working Directory
COPY ./src ${HOME}/src

# Compile the project
RUN npx tsc

# Copy built artifacts and dependencies into a minimal release image
FROM node:current-alpine AS release

LABEL Description="Project for aggregating prometheus exporter metrics."

# Create Directory for the Container
WORKDIR /fp

COPY --from=build ${HOME}/node_modules node_modules
COPY --from=build ${HOME}/dist dist
COPY --from=build ${HOME}/package.json package.json

# Runs on container start
CMD node ./dist/sock.js
