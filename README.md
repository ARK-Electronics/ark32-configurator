# ARK32 Configurator

Fork of the [AM32 configurator](https://github.com/am32-firmware/am32-configurator) maintained by ARK Electronics for **ARK32** ESC firmware and ArduPilot passthrough reliability.

Web UI for reading/writing ESC settings and flashing ARK32/AM32 firmware over USB serial (MSP → 4-way / BLHeli passthrough).

## Browser requirements

Web Serial is required:

- **Chrome** or **Edge** (Chromium)
- Firefox/Safari do not support Web Serial
- Production hosting **must use HTTPS** (or `localhost` for local dev)

## Local development (recommended for testing passthrough)

Passthrough logic runs entirely in the browser against the flight controller USB serial port. You do **not** need MariaDB/Redis for basic connect / enumerate / read-write testing.

### Prerequisites

- Node.js 20+ (see `.nvmrc`)
- Yarn 4 via corepack
- Chromium-based browser (Chrome or Edge — required for Web Serial)

### One-shot: install, start, open browser

```bash
./run.sh                 # http://localhost:3000 in Chrome/Edge
./run.sh --port 3001
./run.sh --no-browser    # server only
```

`run.sh` runs `yarn install` if needed, starts `yarn dev`, waits until the port is up, then opens Chromium. Ctrl-C stops the server.

### Manual

```bash
cd /path/to/ark32-configurator

corepack enable
yarn install

# Optional: only needed for admin / downloads / sponsors APIs
# export DATABASE_URL='mysql://am32:am32password@127.0.0.1:3308/am32'
# export REDIS_HOST=127.0.0.1

yarn dev
```

Open **http://localhost:3000** (or the port Nuxt prints).

### Test ArduPilot ESC passthrough

1. FC on USB, ESCs powered, props off
2. GCS **disconnected** from the COM port (Mission Planner/QGC must release the port)
3. Open the configurator → select the FC serial device → Connect
4. Confirm all ESCs enumerate (watch the in-app log for `ESC #N OK` / failures)
5. Parameters for ArduPilot (typical):
   - DShot output protocol on the motor outputs
   - `SERVO_BLH_AUTO=1` (or correct `SERVO_BLH_MASK`)
   - Motors on **AUX/FMU** outputs (not IOMCU MAIN)
   - Safety switch pressed/disabled

### What this fork changes for reliability

- Longer host timeouts for 4-way / soft-serial (settings reads were racing at 200ms)
- RX drain between exchanges so timed-out partial packets do not poison the next ESC
- Inter-ESC settle delay during enumeration (reduces “channel 4 missing”)
- More init retries on first enumerate (matches post-flash path)
- Safer MSP default timeout (was 50ms)

## Production / local Docker

### Simple local full stack (app + MariaDB + Redis)

```bash
cp stack.env.example stack.env
docker compose -f docker-compose.local.yml up --build
```

App: http://localhost:3000

### Traefik / existing proxy stack

The original `docker-compose.yml` expects external Docker networks `proxy` and `redis-net` (Traefik-style). Use that when integrating into an existing reverse-proxy host:

```bash
cp stack.env.example stack.env
# set DOMAIN=configurator.example.com
docker compose up --build -d
```

## Hosting for customers (like flight-review)

This is a **Nuxt SSR-disabled SPA + Nitro server** (firmware list, admin, sponsors). Customers only need the HTTPS site; serial I/O is browser ↔ FC USB.

### Recommended topology (mirrors ARK flight-review)

Same pattern as `flight_review` / `ARK-OS/services/flight-review`:

```text
Internet → Nginx (TLS, optional basic auth) → configurator:3000
                ↳ certbot for Let’s Encrypt
         Redis + MariaDB (firmware metadata / admin)
```

| Piece | Role |
|-------|------|
| Nginx + Let’s Encrypt | HTTPS (required for Web Serial off localhost) |
| `docker/Dockerfile` app | Serves UI + API on port 3000 |
| MariaDB | Admin users, sessions, sponsors |
| Redis | Cached firmware release metadata |
| Object storage (optional) | Hex/bin firmware blobs (MinIO/S3) |

### Minimal VPS checklist

1. DNS: `ark32-config.example.com` → VPS
2. Clone `ARK-Electronics/ark32-configurator`, set `stack.env`
3. Run `docker-compose.local.yml` (or production compose with nginx)
4. Terminate TLS on nginx (copy the flight-review nginx/certbot layout if you already use it)
5. Open 443 only; keep MariaDB/Redis off the public interface
6. Smoke-test from a customer machine: Chrome → HTTPS URL → Web Serial → enumerate ESCs

### What does *not* need hosting

- The ESC serial protocol itself (browser Web Serial)
- Flight controller firmware (customers already have ArduPilot)

### What *does* need hosting if you want parity with am32.ca

- Firmware download catalog (`/api/files`, Redis + storage)
- Admin UI for sponsors/users
- Automatic release pull from GitHub (see `src/fetch-and-upload-releases.ts`)

If you only need **passthrough configuration** (read/write settings on already-flashed ESCs), a static-ish deploy of the Nuxt app with degraded downloads is enough; customers can still flash via local hex upload.

## Build without Docker

```bash
yarn build
node .output/server/index.mjs
# HOST=0.0.0.0 PORT=3000
```

## Repo remotes

| Remote | URL |
|--------|-----|
| `ark` | `git@github.com:ARK-Electronics/ark32-configurator.git` |
| `origin` | upstream am32-configurator (reference only) |

Branch used for ARK releases: **`ark-release`**.

## License

Same as upstream AM32 configurator unless otherwise noted.
