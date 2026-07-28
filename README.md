# ARK32 Configurator

Web UI for configuring and flashing ARK32 ESCs over USB serial. Chrome or Edge required.

## Run locally

```bash
git clone git@github.com:ARK-Electronics/ark32-configurator.git
cd ark32-configurator
git checkout ark-release
./run.sh
```

That installs deps if needed, starts the dev server, and opens Chromium at http://localhost:3067.

## What is different from upstream AM32 configurator

| Area | Change |
|------|--------|
| **Serial timeouts** | Longer host timeouts for soft-serial 4-way (settings reads were racing ~200 ms) |
| **RX drain** | Discard stale serial data between exchanges so a timed-out read does not poison the next ESC |
| **Enumeration** | Inter-ESC settle delay and more init retries (reduces “last channel / channel 4” failures) |
| **MSP timeout** | Safer default (was 50 ms; could miss slow `MSP_SET_PASSTHROUGH` replies) |
| **Local tooling** | `./run.sh` one-shot launcher; `docker-compose.local.yml` for full stack |

Repo default branch: **`ark-release`**.
