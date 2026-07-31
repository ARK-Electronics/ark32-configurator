# ark32

Headless configurator for [AM32](https://github.com/am32-firmware/AM32) ESCs behind
a flight controller, over MSP and BLHeli 4-way passthrough.

It is the same protocol stack the [ARK32
configurator](https://github.com/ARK-Electronics/ark32-configurator) web app runs —
one `Am32Session`, one link layer, one timeout policy derived from the flight
controller's own published budgets. There is no second implementation, which is the
point: a fix in one is a fix in both.

## Install

```sh
npm i -g @ark/am32-cli
```

Node 20.11 or newer. `serialport` is the only runtime dependency and ships
prebuilt bindings for linux x64/arm64, macOS x64/arm64 and Windows x64, so there is
no compiler step.

Standalone builds for those five targets are attached to each
[release](https://github.com/ARK-Electronics/ark32-configurator/releases) for
machines with no Node.

## Use

```sh
ark32 ports                                     # serial ports, with VID:PID
ark32 -p /dev/ttyACM0 info                      # FC variant, API version, motors
ark32 -p /dev/ttyACM0 enumerate                 # per-ESC status; partial-safe
ark32 -p /dev/ttyACM0 read  --esc all -o backup # dump each ESC's settings image
ark32 -p /dev/ttyACM0 write --esc all -i backup/esc-1.bin
ark32 -p /dev/ttyACM0 get   --esc 1 TIMING_ADVANCE
ark32 -p /dev/ttyACM0 set   --esc all TIMING_ADVANCE=16
ark32 -p /dev/ttyACM0 defaults --esc all
ark32 -p /dev/ttyACM0 flash --esc 1 --hex AM32_ARK_4IN1_F051_3.0-ark.hex
ark32 -p /dev/ttyACM0 reset --esc all
```

`--esc` is 1-based, as the ESCs are numbered everywhere else: `1`, `all`, or a list
like `1,3`.

`ark32 --help` is the full flag list.

## `--sim`

Every command runs against a simulated flight controller and its ESCs, with no
hardware:

```sh
ark32 --sim enumerate --escs 4
ark32 --sim --fc betaflight --escs 2 info
ark32 --sim --fault esc3=unresponsive --json enumerate
```

The simulator models both FC profiles (ArduPilot's 4 s MAVLink-idle handoff,
Betaflight's blocking 4-way loop), the AM32 bootloader's page-erase-on-write
semantics and 19200-baud soft-serial timing. It is a peer of the real transports
rather than a test mock, so `--sim` exercises the same session code a board does —
which makes it useful for reproducing a reported failure, and for a CI smoke test.

`--fault` injects one of eleven faults; `ark32 --help` lists them.

## Scripting

`--json` prints one object per command on stdout, and nothing else — logs and
progress go to stderr.

```sh
ark32 --sim --json enumerate | jq '.escs[] | select(.ok == false)'
```

Exit codes:

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | some ESCs failed — the per-ESC results say which |
| `2` | connect or FC detection failed; nothing is known about the ESCs |
| `3` | bad arguments; nothing was attempted |

## What `write` does not write

`ark32 write -i FILE` applies a settings image while preserving six fields the file
may contain: the boot byte, the layout revision, the bootloader version, the two
firmware-version bytes and the CAN block. They are an ESC's identity and its
firmware's own bookkeeping rather than tunables — applying one ESC's saved
configuration to four would otherwise give a DroneCAN board four ESCs with the same
node ID, and a file saved from a half-flashed ESC would leave a working board
sitting in its bootloader.

Everything else in the file is applied, byte-preserving: bytes the layout does not
name, and fields the ESC's layout revision excludes, are left exactly as the ESC had
them. `ark32 set` writes any field you name explicitly.

## Licence

MIT.
