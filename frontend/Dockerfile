FROM node:22-alpine

WORKDIR /app

# Install dependencies first (layer cached unless package.json changes)
COPY package.json package-lock.json* ./
RUN npm install

COPY . .

# Vite env defaults (overridden by docker-compose environment block)
ENV VITE_API_BASE=http://localhost:8000
ENV VITE_SANDBOX_HOST=localhost

EXPOSE 5173

# --host 0.0.0.0 ensures Vite listens on all interfaces inside the container.
# vite.config.ts also sets host: true, but the CLI flag is the safe belt.
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
