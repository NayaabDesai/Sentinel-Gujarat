FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

ENV VITE_API_BASE=http://localhost:8000
ENV VITE_SANDBOX_HOST=localhost

EXPOSE 5173

CMD ["npm", "run", "dev"]
