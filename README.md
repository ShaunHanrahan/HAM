# 🛰 HAM: High-Apogee Monitor

An interactive 3D globe that plots live satellites in orbit using the [n2yo API](https://www.n2yo.com/api/). Search for a satellite, jump to it, and follow it while its orbit path is drawn in real time — on a desktop browser or on your phone.

HAM is meant to run on your own network, for yourself or your household. It's not built to be a shared, multi-user, or public-facing service.

## Features

- **3D globe.** A GPU-rendered three.js globe with earth textures and a star background. Satellites are drawn as a single GPU point cloud, so it stays smooth even with thousands of objects on screen.
- **Live overhead view.** Shows what's currently above your location, filtered by category (Starlink, GPS, ISS, amateur radio, and so on). The set refreshes every 5 minutes; in between, each satellite keeps moving because the browser propagates its orbit.
- **Your spot on the globe.** Once you allow location access or type in coordinates, a map pin marks where you are, so it's clear where the overhead view is centered. The pin stays the same size on screen as you zoom in and out.
- **Search and jump.** Type a name to filter the overhead satellites, or enter a NORAD ID to track any satellite in the catalog.
- **Follow mode.** Click a satellite (or a search result) to lock the camera onto it. Its full orbit path is drawn from real orbital data, and a live readout shows latitude, longitude, altitude, speed, period, and inclination.
- **Broadcast frequencies.** The follow panel lists the satellite's transmitters (downlink, uplink, and beacon frequencies, plus mode), merged from two keyless sources and tagged by origin. One is the [SatNOGS DB](https://db.satnogs.org/), resolved by the satellite's `sat_id` rather than its NORAD id. That's more complete, and it also reaches entries SatNOGS stores without a NORAD id, including a lot of weather and imaging birds. The other is the [JE9PEL amateur-satellite list](https://www.ne.jp/asahi/hamradio/je9pel/). n2yo's own API doesn't expose frequencies, and not every satellite turns up in either source.
- **About this satellite.** One click in the follow panel pulls up a Wikipedia photo and summary for whatever you're tracking. It's found by matching the NORAD id to Wikidata first, and falling back to a plain name search when there's no direct match.
- **Favorites and pass reminders.** Star a satellite and pick how many minutes of notice you want, and your browser will notify you shortly before it rises over you. The rise time is worked out on your own device from the orbital elements, and your favorites and reminders live only in your browser's local storage.
- **Works on phones.** On small screens the sidebar becomes a bottom sheet. Swipe or tap the grabber to expand it, and following a satellite slides its details up automatically. Drag with one finger to rotate the globe, pinch with two to zoom.
- **n2yo proxy.** A tiny, zero-dependency Node server proxies every n2yo call, so your API key stays off the frontend and CORS is handled for you. Responses are cached briefly to stay within n2yo's rate limits. No `npm install` needed.

## Setup

### With Docker (recommended)

You only need Docker installed, not Node.

1. **Get a free n2yo API key.**
   Register at <https://www.n2yo.com/api/>. Once you sign in, your API key is shown in your account.

2. **Add your key.**
   Copy the example env file and paste your key in:
   ```bash
   cp .env.example .env
   ```
   Then edit `.env` and set `N2YO_API_KEY=...`

3. **Start it.**
   ```bash
   docker compose up -d
   ```
   This pulls the published image from GitHub's container registry and runs it. No build step, no Dockerfile needed on your machine.

4. **Open** <http://localhost:10489> in your browser, or `http://<your machine's LAN IP>:10489` from another device on your network.
   Allow location access when prompted so the overhead view is centered on you. Browsers only show that prompt on HTTPS or on localhost, so opening this from another device over plain HTTP (the normal case on a LAN) won't ask, and it falls back to 0°, 0°. Click 🌐 Coordinates in the app and enter your latitude and longitude instead.

If you'd rather skip compose, this is the same thing by hand:
```bash
docker pull ghcr.io/shaunhanrahan/ham:latest
docker run -d --name ham -p 10489:10489 --env-file .env ghcr.io/shaunhanrahan/ham:latest
```

If you change `PORT` in `.env`, update the port mapping (`10489:10489` above) to match.

If you've cloned this repo and want to run your own changes instead of the published image, build and tag it yourself first, and compose will use that instead of pulling:
```bash
docker build -t ghcr.io/shaunhanrahan/ham:latest .
docker compose up -d
```
If the globe or textures ever look wrong in your own build, rebuild without the cache to force a clean re-download: `docker build --no-cache -t ghcr.io/shaunhanrahan/ham:latest .`

### Without Docker

All you need is Node 18 or newer.

1. Get a key and set up your `.env` file the same way as steps 1 and 2 above.
2. Run it:
   ```bash
   npm start
   ```
   (or just `node server.js`)

   On the first start, the server downloads its front-end libraries and the globe textures into `public/vendor/` and serves them from there afterwards. That means the app has no runtime dependency on any CDN: after the first run it works fully offline, apart from the live n2yo and SatNOGS data, which is inherently remote. So the first run needs internet, which it already does for the satellite data anyway.
3. Open <http://localhost:10489> in your browser and allow location access when prompted, same as above.

Either way you run it, the security posture is the same: no built-in auth on the `/api/*` proxy, so keep it on a network you trust rather than exposing it to the wider internet (more on that in Security & deployment below).

## How it works

```
browser (three.js + satellite.js)
        │  /api/above, /api/tle/:id, /api/frequencies/:id
        ▼
  Node proxy (server.js)  ──►  api.n2yo.com      (positions, TLEs; adds your API key)
                          └──►  db.satnogs.org    (transmitter frequencies; no key)
```

- The overhead view comes from n2yo's `/above` endpoint, where one call returns many satellites.
- When you follow a satellite, the app fetches its TLE (orbital elements) from n2yo once, then propagates the orbit in your browser with [satellite.js](https://github.com/shashwatak/satellite-js). That gives you a smooth, continuously updating position and a full orbit path without hammering the API.

## Notes on rate limits

n2yo enforces hourly limits per endpoint: above 100/hr, tle 1000/hr, positions 1000/hr, passes 100/hr. The `/above` limit is the tight one, so the app is built to lean on `/tle` instead, which has ten times the headroom:

- `/above` is called rarely, only to discover what's currently overhead, every 5 minutes (roughly 12 an hour). The server caches each response for 2 minutes on top of that.
- The cloud animates client-side. Each satellite's TLE is fetched once, cached in your browser's `localStorage` for 12 hours (and on the server for 1 hour), then propagated locally with satellite.js every frame. Once the orbits are loaded, the dots keep moving with no further API calls.
- Only the closest ~150 satellites are plotted (`MAX_SATS` in `index.html`), which caps the one-time TLE fetch.

What still costs API calls: switching to a new category or sky radius fetches TLEs for any satellites you haven't seen before (which are then cached). Normal use stays comfortably under every limit, and you can watch your usage on your n2yo profile page.

## Customizing

- **Default category and refresh rate.** Edit the `setInterval(refreshCloud, 300000)` line (the overhead-membership refresh, in ms) and the category `<select>` in `public/index.html`.
- **Animate the whole cloud.** Right now only the followed satellite is propagated in the browser. You could fetch a TLE for every overhead satellite and animate them all, but that burns through far more of your n2yo quota.

## Security & deployment

- **Run it behind your own auth, or on a trusted network.** The `/api/*` proxy has no built-in authentication or rate-limiting; it just forwards requests to n2yo using your API key. Exposed raw to the internet, it becomes an open proxy that anyone could use to burn through your n2yo quota, so don't deploy it publicly without an auth layer in front.
- **Keep your key out of git.** Your n2yo key lives only in `.env`, which is already in `.gitignore`, so never commit it. `.env.example` holds a placeholder and nothing else. If your key is ever exposed, rotate it in your [n2yo account](https://www.n2yo.com/api/).
- Untrusted catalog text (satellite names, transmitter descriptions) is HTML-escaped before it's displayed. The proxy also constrains the upstream parameters (NORAD ids must be numbers; names are sent only as URL-encoded query values) and pins every upstream (n2yo, SatNOGS, JE9PEL, Wikipedia/Wikidata) to a fixed host, so there's no injection or SSRF surface.

### Checking your key hasn't leaked into git

If you've forked or cloned this repo and are pushing your own changes, it's worth a quick check before each push that your key is still only in `.env`:

```bash
# 1. Confirm .env is ignored (should print: .env)
git check-ignore .env

# 2. Make sure the key isn't staged or committed anywhere (should print nothing)
git grep -nI "$(grep -E '^N2YO_API_KEY=' .env | cut -d= -f2-)" 2>/dev/null

# 3. Review exactly what you're about to commit
git status
```

If `.env` ever shows up as tracked, remove it (`git rm --cached .env`) and rotate the key at n2yo. Once a secret has been pushed, treat it as compromised even if you delete it afterwards.
