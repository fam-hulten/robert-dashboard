FROM node:22-alpine

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev

COPY server.js .

# Mount workspace directory for reading metrics files
VOLUME /workspace

ENV PORT=3090
ENV WORKSPACE=/workspace

EXPOSE 3090

CMD ["node", "server.js"]
