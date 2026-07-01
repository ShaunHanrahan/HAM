# 🛰 HAM: High-Apogee Monitor

An interactive 3D globe that plots live satellites in orbit using the [n2yo API](https://www.n2yo.com/api/). Search for a satellite, jump to it, and follow it while its orbit path is drawn in real time.

## Features

- **3D globe.** A GPU-rendered three.js globe with earth textures and a star background. Satellites are drawn as a single GPU point cloud, so it stays smooth even with thousands of objects on screen.
- **Live overhead view.** Shows what's currently above your location, filtered by category (Starlink, GPS, ISS, amateur radio, and so on). The set refreshes every 5 minutes; in between, each satellite keeps moving because the browser propagates its orbit.
- **Search and jump.** Type a name to filter the overhead satellites, or enter a NORAD ID to track any satellite in the catalog.
- **Follow mode.** Click a satellite (or a search result) to lock the camera onto it. Its full orbit path is drawn from real orbital data, and a live readout shows latitude, longitude, altitude, speed, period, and inclination.
- **Broadcast frequencies.** The follow panel lists the satellite's transmitters (downlink, uplink, and beacon frequencies, plus mode), merged from two keyless sources and tagged by origin. One is the [SatNOGS DB](https://db.satnogs.org/), resolved by the satellite's `sat_id` rather than its NORAD id. That's more complete, and it also reaches entries SatNOGS stores without a NORAD id, including a lot of weather and imaging birds. The other is the [JE9PEL amateur-satellite list](https://www.ne.jp/asahi/hamradio/je9pel/). n2yo's own API doesn't expose frequencies, and not every satellite turns up in either source.
- **n2yo proxy.** A tiny, zero-dependency Node server proxies every n2yo call, so your API key stays off the frontend and CORS is handled for you. Responses are cached briefly to stay within n2yo's rate limits. No `npm install` needed.

## Setup

You only need Node 18 or newer installed.

1. **Get a free n2yo API key.**
   Register at <https://www.n2yo.com/api/>. Once you sign in, your API key is shown in your account.

2. **Add your key.**
   Copy the example env file and paste your key in:
   ```bash
   cp .env.example .env
   ```
   Then edit `.env` and set `N2YO_API_KEY=...`

3. **Run it.**
   ```bash
   npm start
   ```
   (or just `node server.js`)

   On the first start, the server downloads its front-end libraries (three.js, satellite.js) and the globe textures into `public/vendor/` and serves them from there afterwards. That means the app has no runtime dependency on any CDN: after the first run it works fully offline, apart from the live n2yo and SatNOGS data, which is inherently remote. So the first run needs internet, which it already does for the satellite data anyway.

4. **Open** <http://localhost:10489> in your browser.
   Allow location access when prompted so the overhead view is centered on you. It falls back to 0°, 0° otherwise.

## Running with Docker

If you don't want to install Node yourself, or you just want this running on a spare
machine on your network, a container works just as well.

1. **Get your key ready.** Same first step as above: copy `.env.example` to `.env` and
   set `N2YO_API_KEY=...`.

2. **Build and start it.**
   ```bash
   docker compose up --build -d
   ```
   The build step fetches the front-end libraries and globe textures once and bakes
   them into the image, so the container starts right away every time after that and
   doesn't need internet at runtime beyond the live satellite data.

3. **Open it.** <http://localhost:10489> on the machine running it, or
   `http://<that machine's LAN IP>:10489` from any other device on your network.

If you'd rather skip compose, this is the same thing by hand:
```bash
docker build -t ham .
docker run -d --name ham -p 10489:10489 --env-file .env ham
```

If you change `PORT` in `.env`, update the port mapping (`10489:10489` above) to match.

If the globe or textures ever look wrong, rebuild without the cache to force a clean
re-download: `docker build --no-cache -t ham .`

The container has the same security posture described below: no built-in auth on the
`/api/*` proxy, so keep it on a network you trust rather than exposing it to the wider
internet.

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

### Before publishing to a public repo

```bash
# 1. Confirm .env is ignored (should print: .env)
git check-ignore .env

# 2. Make sure no secret is staged anywhere (should print nothing)
git grep -nI "$(grep -E '^N2YO_API_KEY=' .env | cut -d= -f2-)" 2>/dev/null

# 3. Review exactly what will be committed before the first push
git status
git add -A && git status   # confirm .env is NOT listed
```

If `.env` ever shows up as tracked, remove it (`git rm --cached .env`) and rotate the key at n2yo. Once a secret has been pushed, treat it as compromised even if you delete it afterwards.
