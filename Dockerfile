FROM node:18
WORKDIR /app

# Copy your script into the image
COPY OctoRelay.js /app/

# Install dependencies
RUN npm install ws

# Run your script
CMD ["node", "OctoRelay.js"]