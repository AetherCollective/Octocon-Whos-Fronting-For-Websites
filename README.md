What you need:
  - A server
  - Docker 
  - Nginx
  - A website (to display who's fronting)
  - Your API Key (obtained by visiting https://beta.octocon.app/app/ and sniffing the network traffic)
  - Your System ID (obtained by visiting https://beta.octocon.app/app/ and sniffing the network traffic)

Configure the `docker-compose.yml` by updating build to point to where `OctoRelay.js` is stored, and set your `API_KEY` & `SYSTEM_ID`. After that, you can build and run it.

Configure `nginx.conf` by updating `proxy_pass` to your Relay IP

Now copy the `<script>` from `website.html` and put it someone on your website. At the top of `<script>`, set your Relay IP and specific an `elementID` to replace.

Respects Security Levels, will only show public members.

Made by the Aether Collective 
Discord: @aethercollective
