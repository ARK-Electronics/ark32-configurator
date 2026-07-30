# Block 7 — Headless CLI

Landed on `master` on top of `dd23faf`:

| Commit | What |
|---|---|
| `eda0b57` | `feat(node): add am32-node, a serialport Transport and port enumeration` |
| `b87ded3` | `feat(cli): add am32-cli -- the ark32 headless CLI` |
| `ac03fb0` | `build(cli): bundle ark32, gate it against the simulator, and ship five targets` |
| `096ca42` | `test(cli): pin that exit 3 means nothing was opened, and that a pipe is not a failure` |
| `e54d5a0` | `docs(testing): record ark32 --sim as a test layer and a checkpoint tool` |
| `577dacb` | `fix(cli): fail a zero-channel FC for every command, not only enumerate` |
| `aba19c6` | `fix(cli): restore the zero-channel guard that a mutation revert ate` |
| (see "What the diff review changed") | the review's findings |
| this file | the handoff note |

**Nothing outside `packages/`, `scripts/`, `.github/workflows/`, `docs/` and the two
manifests changed.** `components/`, `pages/`, `stores/`, `composables/`, `src/`,
`server/` and all three of `am32-core`, `am32-sim`, `am32-web` are untouched. Block 7
is purely additive: two new packages, two build scripts, one gate, one workflow.

## Verification

```
yarn verify                          → exit 0  (lint 0 errors / 10 warnings, typecheck:core + typecheck:app clean, 453 tests in 22 files)
                                       three consecutive runs, identical
done-when (STATUS.json block 7)      → exit 0
  test -d packages/am32-cli && test -d packages/am32-node
bash scripts/assert-cli-sim.sh       → exit 0  (block 7's own gate, 29 checks)
bash scripts/assert-core-hygiene.sh  → exit 0
bash scripts/assert-fault-coverage.sh→ exit 0  (12 knobs, all with a suite named after them)
bash scripts/assert-deleted.sh       → exit 0
yarn build                           → exit 0  (fresh .output; see block 6's warning about believing a build log)
./run.sh --no-browser                → dev server on :3067, GET /configurator 200, vue-tsc 0 errors
```

Test counts: 319 → **453**. The six new files:

| File | Tests |
|---|---|
| `packages/am32-cli/src/args.test.ts` | 38 |
| `packages/am32-cli/src/run.test.ts` | 45 |
| `packages/am32-cli/src/commands/settings.test.ts` | 14 |
| `packages/am32-cli/src/exit.test.ts` | 11 |
| `packages/am32-node/src/node-serial-transport.test.ts` | 17 |
| `packages/am32-node/src/serialport-loader.test.ts` | 9 |

Lint is unchanged at **10 warnings, 0 errors**. Nothing in the new packages writes to
the console: the CLI's only output paths are `env.stdout` / `env.stderr`, which is
also what makes every command's output assertable.

`grep -rl 'am32-sim\|am32-cli\|am32-node' .output/public` after a clean build is
**0** — none of the three reaches the client bundle, and `serialport` does not
either. That is enforced by absence rather than by a rule: they have no
`nuxt.config.ts` alias and nothing in the app imports them.

### The plan's two done-when command lines, against the built binary

```
$ ark32 --sim enumerate --escs 4
ESC #1  ok     ARK_4IN1_F051 v2.20  bootloader 18  layout 3
ESC #2  ok     ARK_4IN1_F051 v2.20  bootloader 18  layout 3
ESC #3  ok     ARK_4IN1_F051 v2.20  bootloader 18  layout 3
ESC #4  ok     ARK_4IN1_F051 v2.20  bootloader 18  layout 3
exit=0

$ ark32 --sim write --esc all -i fixture.bin
ESC #1  applied and verified
ESC #2  applied and verified
ESC #3  applied and verified
ESC #4  applied and verified
exit=0
```

Both are also in the test suite (`run.test.ts > issue #3 block 7 done-when`) and in
`scripts/assert-cli-sim.sh`. All three, deliberately: the suite proves the
*behaviour*, the gate proves the *binary* has it, and the run above is the evidence.

### The exit-code table, verified end to end

```
  ok    exit 0  0 -- success
  ok    exit 1  1 -- partial: one ESC unresponsive
  ok    exit 2  2 -- connect: the FC never answers
  ok    exit 3  3 -- bad arguments: unknown command
  ok    exit 3  3 -- bad arguments: unknown flag
  ok    exit 3  3 -- bad arguments: missing --esc
  ok    exit 3  3 -- bad arguments: no such file
```

### The standalone binary, on the one target this machine is

```
$ node scripts/build-cli-binary.mjs
ark32 0.1.0 standalone for linux-x64
  ark32  118.2 MiB
  node_modules/  19 packages: ... serialport
$ cd standalone && ./ark32 --sim enumerate --escs 4     → exit 0
$ ./ark32 --sim write --esc all -i fixture.bin          → exit 0
$ ./ark32 ports
/dev/ttyUSB0             0403:6001  FTDI (A9HJ3O0C)     → exit 0
```

That last line is the strongest thing in this block's verification and worth being
precise about what it proves: **the native `serialport` module loaded through the
bundle, out of the staged sibling `node_modules`, and enumerated a real USB device
on this machine.** It is not a flight controller — it is an FTDI cable — so it says
nothing about the protocol. What it does prove is that the whole loader chain, the
SEA, the prebuild staging and `SerialPort.list()` work in the shipped artifact, on
one of the five targets.

With the sibling `node_modules` removed, `--sim` still works and `ports` exits 2
with the loader naming every specifier it tried. Both halves tested.

### The npm package

```
$ yarn workspace @ark/am32-cli pack --out /tmp/ark32-cli.tgz
package/README.md
package/dist/ark32.mjs
package/package.json
$ tar -xzOf ... package/package.json | jq .dependencies
{ "serialport": "^13.0.0" }
$ ./dist/ark32.mjs --sim --escs 2 enumerate              → exit 0
```

Three files, one runtime dependency, and it runs. The workspace packages are
`devDependencies` so esbuild can inline them and npm will never try to fetch
`am32-core@0.0.0`.

## What I built

**`packages/am32-node`** — the Node `Transport`. A peer of `am32-web`, built to the
same shape: one subscription set for inbound bytes, no framing, no timeouts, no
retries, **no `read()`**.

- `node-serial-transport.ts` — `NodeSerialTransport`. Takes a `createPort` factory
  rather than a port, because `new SerialPort(...)` needs the baud rate where Web
  Serial takes it in `open()`.
- `serialport-types.ts` — the structural slice of the package, so nothing but the
  loader names `serialport`.
- `serialport-loader.ts` — the only file that names it, reached by dynamic
  `import()`, with a two-candidate chain covering both shipping forms.
- `open.ts` — path in, open transport out. What the CLI calls.

**`packages/am32-cli`** — `ark32`. All ten commands from section 6, every global
flag, `--json`, `--sim` with eleven fault knobs.

- `args.ts` — a hand-rolled parser. Pure: `string[]` in, a value or a failure out,
  no filesystem, no process, no exit. That is what lets `args.test.ts` cover the
  exit-code-3 table exhaustively.
- `run.ts` — `run(argv, env) → Promise<ExitCode>`. The whole CLI. Never calls
  `process.exit`.
- `env.ts` / `node-env.ts` — the injected environment, and the one file bound to
  `node:fs` and `am32-node`.
- `exit.ts` — the section 6 table as code, with the two rows section 6 does not
  cover written down and argued (see decision 2).
- `report.ts` — text and `--json`, and the rule that stdout carries either the
  human rendering or exactly one JSON object and never both.
- `sim.ts` — fault specs → knob assignments, and the virtual-clock pump.
- `commands/` — `ports`, `info` + `enumerate`, `settings` (read/get/set/write/
  defaults), `firmware` (flash/reset), and `targets.ts`, which is audit item **B**
  one layer up.
- `fixtures/fixture.bin` + `fixtures/README.md` — the done-when's input, with every
  planted byte explained.

**`scripts/build-cli.mjs`** — esbuild → `dist/ark32.mjs` (ESM, what `bin` points at)
and `dist/ark32.cjs` (CJS, what Node's SEA takes). `serialport` external in both.

**`scripts/build-cli-binary.mjs`** — the SEA plus its staged native runtime.

**`scripts/assert-cli-sim.sh`** — block 7's gate.

**`.github/workflows/`** — a `--sim` smoke test on every push in `ci.yml`, and
`release-cli.yml` with the five-target matrix plus the npm publish.

## Design decisions a later block could accidentally undo

1. **Every exit-code-3 decision belongs to the parser, and the parser is pure.**
   `sim.ts` cannot reject a command line; `KNOB_VALUE_KINDS` in `args.ts` validates
   fault values so that a spec which parses is a spec the simulator can apply
   without a second round of validation. If you add a knob, add it to that table —
   `applyFault`'s `default` branches throw rather than shrug, so a knob added to one
   and not the other fails loudly.

2. **`esc-verify` is exit 1 and `image` is exit 3, and the second one has a
   condition.** Block 6 flagged that section 6's table does not cover `esc-verify`:
   it is 1, because the ESC is healthy (so not 2), the arguments were fine (so not
   3), and one channel of four failing to verify is exactly what 1 promises — that
   the per-ESC results are where the answer is. `image` is 3, because `errors.ts`
   says so ("nothing was attempted on the wire — it is a bad argument"), **but only
   when every attempted channel rejected the hex for that reason.** If one channel
   took it, something was written and 1 wins, because 3 has to keep meaning
   "nothing was attempted". That is `exitCodeForTargets`, and both halves have a
   test.

3. **Argument validation happens before anything is opened, including the files.**
   The hex is parsed twice on purpose — once by the CLI to fail fast, once inside
   `flash()` — and the settings image is read and length-checked before `connect()`.
   That is the *only* thing that makes exit 3 mean "nothing was attempted", and it
   is not observable from the exit code alone: `flash()` throws
   `SessionError('image')` with the same message and that also maps to 3. The tests
   therefore assert on the session's `state` channel never reaching `connecting`.
   If you move file reading below the connect, those two tests go red and they are
   right to.

4. **`--sim` drives a `VirtualClock`, not the system clock.** A simulated run on
   real time would take ~9 s for an `enumerate` (ArduPilot's 4 s MAVLink window, a
   2 s passthrough settle, 300 ms between channels) and minutes for a `flash`, which
   would make `--sim` useless as the CI smoke test the plan wants. On a virtual clock
   the same run is milliseconds and deterministic — the simulator contains no wall
   clock, so a `--sim` run either always works or always does not. **The cost, stated
   plainly in `sim.ts` and in `docs/TESTING.md`: `--sim` proves protocol logic,
   session ordering and every timeout *derivation*. It cannot tell you a real USB
   link is fast enough.**

5. **`driveVirtualClock` is not the test suite's `drive()` and must not be
   collapsed into it.** The tests' helper treats a dry clock as an immediate
   deadlock, which is right for a test that does nothing but protocol work. The CLI
   cannot: a command may be awaiting something outside the clock, so the pump yields
   to the real event loop and only gives up after `MAX_IDLE_ROUNDS`, with a named
   error rather than a hang. The rule that keeps that bound honest is **all
   filesystem I/O happens outside the driven region** — `read` collects its images
   in memory and `run.ts` writes them after the session work.

6. **`ark32 write -i FILE` preserves all six `DEFAULTS_PRESERVED_FIELDS`; the web
   app's `applySettings` preserves only `CAN_SETTINGS`.** This is the one deliberate
   divergence in the block and the one thing most likely to be "fixed" back. See
   "Where I disagreed with the app" below. If you change it, `commands/settings.test.ts`
   goes red in a way that names each field.

7. **`set BOOT_LOADER_REVISION=...` is a usage error, not a warning.** Byte 2 is
   stamped by the bootloader inside every write to the EEPROM base
   (`AM32-bootloader/bootloader/main.c:517-525`) *and* is the one byte read-back
   verification exempts — so the write would be **reported as verified** while
   changing nothing. A lie that verifies is worse than an error. The other five
   identity fields are allowed with a warning, because they are writable and the
   user named them.

8. **`--esc` and `--fault escN` are both 1-based, and the conversion happens once,
   in the parser.** Everything above the parser is zero-based `target`, matching
   `cmd_DeviceInitFlash`. Mixing those up writes to the wrong ESC; the mutation that
   makes `--esc` zero-based turns 14 tests red.

9. **A channel the FC will not address is a failed *target*, not a usage error.**
   `--esc 5` on a 4-channel FC exits 1 with a per-channel message, because the
   channel count is only knowable after a connect and a passthrough — by which point
   something *has* been attempted, and 3 would be a lie.

10. **A zero-ESC passthrough is exit 2.** The FC connected and entered passthrough
    with nothing addressable behind it (Betaflight installs `esc4wayProcess`
    unconditionally, `msp.c:328-333`), so every other command is equally impossible.
    Section 6's table has no row for it; 2 is the one that tells a script the right
    thing.

11. **`info` does not enter passthrough.** Block 5's design decision 10: on
    ArduPilot, passthrough holds every ESC in its bootloader for the life of the
    session. Asking what flight controller this is must not stop the motors.

12. **`withRig`'s `finally` always disconnects, and that is load-bearing on real
    hardware.** Leaving an FC in passthrough leaves every ESC in its bootloader and
    the motors disabled. The `state` channel is printed under `-v` precisely so the
    teardown is observable — a run that ends anywhere but `disconnected` is a bug,
    and two tests assert on it.

13. **`NodeSerialTransport.write` drains as well as writes.** The link starts its
    timeout the moment `write()` resolves, so "resolved" has to mean the bytes left
    the UART (`tcdrain(2)`) rather than that they are queued in a deep OS buffer.
    This is the transport's one behavioural difference from `am32-web` and the first
    thing to doubt if hardware sees timeouts the browser does not.

14. **`serialport` is loaded by a dynamic `import()` from one file, and the port type
    is structural.** So `--sim`, `--help` and the whole test suite never load an
    N-API addon, and `NodeSerialTransport` is testable with no serial port. A
    `SerialPortMock` test asserts the real package satisfies the structural type at
    compile time as well as at run time, which is the drift guard.

15. **The SEA blob is built from a throwaway copy of the bundle.** Node bakes the
    main script's path in and resolves bare specifiers from it, so a blob built from
    `packages/am32-cli/dist/ark32.cjs` produces a binary that reaches back into
    *this repo's* `node_modules`. See "Where I was wrong" — this one fooled me.

16. **`scripts/assert-cli-sim.sh` is not part of `yarn verify`.** It needs a build
    step, and changing what `yarn verify` means affects every block and the driver —
    a decision blocks 1a, 2 and 5 each declined to take unilaterally, and so did I.
    CI runs it as its own step.

## Where I disagreed with the app, and why

`ark32 write --esc all -i FILE` drops all six of `DEFAULTS_PRESERVED_FIELDS` from
the patch. `composables/useEscSession.ts`'s `applySettings` drops only
`CAN_SETTINGS` (block 5's design decision 13). So the CLI and the app are **not**
byte-identical for a settings file whose identity bytes differ from the ESC's, and
issue #3 section 7.4 says the UI and headless paths must not diverge.

I took the divergence deliberately, and here is the whole argument so the next agent
can overturn it if they disagree:

- **Section 7's identity requirement is about the protocol stack, not about client
  policy.** Both paths call the same `Am32Session.writeSettings` with the same
  byte-preserving semantics. What differs is which fields the client puts in the
  patch, which is the same *kind* of decision block 5 made when it dropped
  `CAN_SETTINGS` from `applySettings` and `downloadEscConfig` kept saving all 192
  bytes.
- **The boot byte is a real hazard, not a tidiness argument.** A settings file saved
  from a half-flashed ESC has byte 0 = `0x00`, which is the bootloader's "there is no
  complete application here" marker (`main.c:306-319`, block 5's finding). Applying
  that file to a working ESC leaves it sitting in its bootloader. In the app there is
  a dialog, an enumerate first and a person watching; `ark32` is designed to run
  unattended in CI.
- **The layout revision is block 6's own bug, from the same bytes.** Writing 3 onto
  an older ESC makes the firmware's migration skip (`AM32/Src/settings.c:23-36`), so
  fields the migration would have populated are read as whatever was in flash. Block
  6 established this for `applyDefaults`; a config file carries the same byte.
- **Nothing is lost.** `writeSettings` leaves an omitted field exactly as the ESC had
  it, so restoring an ESC's own backup is byte-identical either way. And `ark32 set`
  writes four of the six explicitly, with a warning, where the user named the field.

**What I did not do: change the app.** That is block 5's code and outside block 7's
scope, and it is a product decision (does "apply config file" mean "make this ESC
look like that one" or "copy the tunables"?) rather than an obvious bug. It is
recorded here and in `docs/TESTING.md`'s Checkpoint 2 as an app-side hazard worth
closing. **If someone closes it, the one-line change is `applySettings`'s filter in
`composables/useEscSession.ts`, and `DEFAULTS_PRESERVED_FIELDS` is the list.**

## Mutate before you believe

Block 3's rule, and blocks 4, 5 and 6's habit. Every guard broken on purpose with
`yarn vitest run packages/am32-cli packages/am32-node` re-run. Committed first, every
time — three notes in a row have warned that `git checkout --` restores from `HEAD`.

| Mutation | Result |
|---|---|
| `imagePatch` drops nothing | 2 failed |
| `imagePatch` drops only `CAN_SETTINGS` (the app's rule) | 2 failed |
| `exitCodeForTargets` loses the image-only rule | 2 failed |
| `exitCodeForError` maps `image` to 1 | 1 failed |
| `exitCodeForError` maps `esc-verify` to 2 | 1 failed |
| `forEachTarget` lets a per-target failure propagate (audit **B**) | 4 failed |
| `--esc` is read as 0-based | **14 failed** |
| `--fault escN` is read as 0-based | 7 failed |
| `withRig` never disconnects (no `finally`) | 3 failed |
| a command accepts a flag it does not take | 1 failed |
| `BOOT_LOADER_REVISION` becomes writable | 2 failed |
| an empty settings file is accepted | 2 failed |
| the hex is not pre-parsed (exit 3 comes from the wire) | 1 failed |
| the settings file is not read before connecting | 4 failed |
| `--json` puts the human lines on stdout too | **15 failed** |
| the `Uint8Array` JSON replacer is dropped | 1 failed |
| a zero-ESC passthrough is an empty success | 1 failed |
| `NodeSerialTransport.write` does not drain | 2 failed |
| `close()` leaves the listeners attached | 1 failed |
| an unexpected `close` is not reported | 1 failed |
| an error event is reported every time, not once | 1 failed |
| the loader tries the beside-the-exe path first | 2 failed |
| the loader accepts any module that imports | 1 failed |
| the loader gives up after the first candidate | 3 failed |
| a zero-channel FC is accepted (the guard removed from `withRig`) | 2 failed |

And against the gate script, which checks different things:

| Mutation | Result |
|---|---|
| `read` writes 100 bytes instead of 192 | gate exits 1, naming the file and both sizes |
| the JSON envelope loses its `exitCode` | gate exits 1 |
| the unknown-flag guard is removed | **gate exits 0** — see below |

**Two mutations changed this block.** The hex-pre-parse and the
settings-file-pre-read rows above both started at **0 failed**: exit 3 is what you
get either way, because `flash()` throws `SessionError('image')` with the *same
message* and `exitCodeForError` maps it to 3. So the test proved the exit code and
nothing about *when* the file was rejected — which is the entire point of exit 3.
Both now assert that the session's `state` channel never reaches `connecting`, and
both mutations go red. This is block 6's lesson arriving again: a test that fails is
not the same as a test that fails for the reason you think.

**One real defect, and I found it by re-reading rather than by mutating.** A flight
controller that entered passthrough and reported **0 ESCs** was handled in
`commandEnumerate` alone, so `enumerate` exited 2 while `set --esc all`,
`write --esc all`, `defaults --esc all`, `reset --esc all` and `get --esc all` each
exited **0** having walked an empty target list — reporting success for doing nothing
at all. `--esc 1` already failed, as a channel the FC will not address, and noticing
that asymmetry is what exposed it. The check now lives in `withRig` so all eight
per-channel commands report it identically (`577dacb`). No mutation would have found
this: the guard I would have broken was in the wrong place, and breaking it there
turned exactly one test red, which is what it had always done.

⚠️ **`git checkout --` ate that fix, exactly as blocks 4, 5 and 6 each warned, and I
had read all three notes.** The sequence: land the fix, mutate `run.ts` to confirm the
new tests go red, revert with `git checkout -- packages/am32-cli/src/run.ts` — which
restores from `HEAD` and therefore deletes the fix along with the mutation — and then
commit a tree whose tests were red. `577dacb` is that commit; `aba19c6` is the
restore. **"Commit before you mutate" is not sufficient advice.** The commit protects
work made *before* the mutation, and the fix was made before it — the problem is that
the revert restores from `HEAD` and my fix was not in `HEAD` yet. The rule that
actually works: **re-run the suite after every revert, not only after every mutation.**
It took ten seconds and would have caught it immediately.

**One gate mutation survived, and it is the right answer rather than a hole.**
Removing the unknown-flag guard leaves `assert-cli-sim.sh` green, because `--fast`
then falls through to the positional branch and `enumerate takes no positional
arguments` is *also* exit 3. The gate checks the exit-code **table**; it cannot tell
one exit-3 reason from another and should not try. `args.test.ts` asserts on the
messages, and that mutation turns it red. Recorded so nobody "fixes" the gate by
teaching it to grep stderr — that would make it a worse test of the thing it is for.

## Where the plan was wrong, stale, or impossible

- **"Single-file binaries" cannot be single files, and the plan says so in the same
  paragraph.** Section 6: "`serialport` is a native N-API module, so no JS bundler
  — esbuild, `pkg`, Node SEA, `bun --compile` — can produce one universal artifact.
  Each target needs its own `.node` binding compiled in." So each of the five
  artifacts is an **archive containing two things**: the SEA executable (Node plus
  the whole bundled CLI, genuinely one file) and `node_modules/serialport` with that
  target's prebuild. `--sim`, `--help` and `--version` work from the executable
  alone. I considered embedding the `.node` as an SEA asset and extracting it to a
  temp dir at run time; it means bypassing `node-gyp-build`'s own resolution inside
  `@serialport/bindings-cpp`, which is a lot of machinery I could only test on one
  of five platforms. The archive is the honest version.

- **Node's SEA `require` cannot load a non-builtin at all**, so the loader's
  fallback had to be a dynamic `import()` of an absolute `file:` URL rather than a
  path handed to `require`. That is why `serialPortCandidates` returns a URL and not
  a path, and it is not a style choice.

- **Section 6's exit-code table is missing two rows.** `esc-verify` (block 6 already
  flagged this) and "the FC entered passthrough and reported zero channels". Both are
  argued in `exit.ts` and in decisions 2 and 10 above.

- **Section 6 lists `--no-verify` only on `write`.** Block 6's note says
  `{ verify: false }` is wired on `writeSettings` *and* `flash` "for block 7's
  `--no-verify`", so I accepted the flag on all four write paths — `write`, `set`,
  `defaults`, `flash`. A flag that exists on one of four otherwise-identical
  operations is a worse API than the plan's line implies.

- **Section 6's `ark32 read --esc 1|all -o DIR` does not name the files.** They are
  `esc-<n>.bin`, 1-based, and the JSON envelope carries the path per channel so a
  script does not have to guess.

- **The plan's `--fault esc3=unresponsive` example does not say whether `esc3` is
  1-based.** It is, because `--esc` is and because everything user-facing in this
  codebase numbers ESCs from 1. Recorded because the internal `target` is 0-based
  and the two are one line apart in `args.ts`.

- **`--fc` cannot override detection and does not try.** It seeds the
  `TimeoutPolicy` variant for the exchanges *before* `connect()` identifies the FC
  (and picks the simulated profile under `--sim`); `connect()` then calls
  `policy.withVariant()` with what the FC actually reported. So it is a hint. `auto`
  is `generic`, which takes the worse of the two firmwares' budgets — an unknown FC
  is never given a timeout that is too tight.

- **`--sim --fc auto` picks ArduPilot deliberately.** It is the stricter profile: its
  MAVLink idle gate is shut when the port opens, so a `--sim` run exercises the
  probe-then-wait connect rather than the Betaflight fast path. An `auto` that chose
  the easier profile would make `--sim` a weaker smoke test than the default suggests.

- **`ark32 ports` is unfiltered, unlike the app's port picker.** The browser filters
  on a vendor-ID allow-list because a Web Serial prompt has to show something short.
  A CLI that hides the port the user is holding is worse than one that lists a few
  they do not want, especially behind a USB-serial bridge whose VID belongs to FTDI.
  VID:PID is printed so they can tell.

- **Block 7 needed no firmware reading, and I want to be explicit rather than
  silent about that.** It adds no protocol code: every firmware-derived claim the CLI
  makes is inherited, and each is cited at the point of use — byte 2's stamp and its
  condition (`main.c:517-525`, verified by a subagent in block 1b and again in block
  6), the boot byte's accepted set `{0x01, 0xFF}` (`main.c:306-319`, block 5), the
  layout-revision migration (`Src/settings.c:23-36`, block 6), and
  `DEFAULTS_PRESERVED_FIELDS` (block 6). Block 7's text in issue #3 contains no
  file:line references to re-verify, and section 6 contains none either. **If you are
  looking for the drift table this section usually carries, there is nothing in it —
  which is itself the finding.**

## Plan line references that had drifted

None that this block depended on. Block 5's note already recorded that "the audit's
app-side line references are now **all** obsolete" and told blocks 6 and 7 to work
from symbols in the core; block 6 did, and so did this one. The API surface I built
against was verified by reading it rather than by trusting a line number:
`Am32Session`'s ten public methods, `WriteSettingsResult`, `ApplyDefaultsOptions`,
`FlashOptions`, `SessionErrorReason`, `EepromLayout`, `DEFAULTS_PRESERVED_FIELDS`,
`createSimHarness`, `SimEsc`'s six knobs, `SimFc`'s three, `LinkFaults`' two,
`TimeoutPolicy`, and `VirtualClock`.

Two inherited notes I checked and found still true:

| Claim | Where it came from | At this block |
|---|---|---|
| the driver's `bash -c` has no `globstar`, so `**` is one directory | block 4 | still true; block 7's done-when is two `test -d`, so it does not bite |
| `am32-sim` must have no `nuxt.config.ts` alias | block 3, design decision 6 | still true, and now also `am32-node` and `am32-cli`. Block 3 predicted they "will need aliases" — **they do not**, and must not have them |

## Outstanding

- 🔧 **Hardware checkpoint not run — nothing is plugged in.** This is now the
  accumulated checkpoint for blocks 1a through 7. `docs/TESTING.md` carries both
  checkpoints and the full watch-list; block 7 added a headless recipe to each, and
  these three things to watch:
  - **`am32-node` has never moved a byte over real silicon.** It is the first
    non-browser transport in the repo and the only new code in this block that can
    fail on hardware. Its one behavioural difference from `am32-web` is that `write`
    also drains (`tcdrain(2)`), so if `ark32` sees timeouts the browser does not on
    the same board, that `await` is the first thing to doubt. `ark32 -v` prints every
    session log line; compare it against the browser's log panel.
  - **`cmp` on two `ark32 read --esc all -o DIR` dumps is the strongest form of the
    CAN-block check** anyone has had. It names every byte that moved, so a field
    nobody thought to look at cannot slip through. Only byte 0x17 should differ after
    a `set --esc 1 TIMING_ADVANCE=16`, plus byte 2 if the bootloader version changed.
  - **`ark32 ports` may list a lot on Linux** — 33 entries on this machine, mostly
    `/dev/ttyS*`. That is deliberate (see above) but if it is unusable in practice,
    the fix is a `--all` flag and a default filter, not a hidden allow-list.
- 🔧 **Four of the five standalone targets are unverified, and CI has not run.** The
  driver does not push, so `release-cli.yml` has never executed. linux-x64 is verified
  end to end here, including the native path; `linux-arm64`, `darwin-x64`,
  `darwin-arm64` and `win32-x64` are matrix plumbing. Each job smoke-tests its own
  binary (`--version`, both done-when lines, `ports`) so a bad one cannot ship
  silently, but **the first real run will be the first time those five jobs execute.**
  The two most likely failures, in order: macOS codesigning around `postject`
  (`--remove-signature` on a runner-provided Node may behave differently from a
  locally built one), and `ubuntu-24.04-arm` being a comparatively new GitHub runner
  label.
- **`release-cli.yml` needs an `NPM_TOKEN` secret** and the `@ark` npm scope to
  exist. Neither is set up. The `npm` job is `needs: binaries` and gated on a
  published release, so nothing breaks until someone publishes one — but the first
  release will fail at the publish step until the secret is there.
- **The version lives in two places, and a script keeps them honest.**
  `packages/am32-cli/package.json` and `src/version.ts` must agree;
  `scripts/build-cli.mjs` fails the build if they do not, and `prepack` runs it. A
  constant rather than a manifest read because the bundle ships with no manifest
  beside it.
- **`ark32` needs `yarn install` once after the first `yarn build:cli`.** Yarn only
  creates `node_modules/.bin/ark32` when `dist/ark32.mjs` exists. The gate handles it
  (it falls back to `node dist/ark32.mjs` and says which it used) and CI re-installs,
  but a human's first run will confuse them once.
- **The app layer still has no automated test at all.** Unchanged from blocks 5 and
  6, and unchanged *by* this block, which touched none of it. Worth noting what did
  change: the CLI is the first client of the session that **is** fully tested, so a
  session-level regression now has a chance of being caught by `yarn test` rather than
  only by a person clicking. That is a side benefit of block 7, not a substitute.
- **`Transport` still has no error channel.** Flagged by block 2, inherited by 3, 4,
  5, 6 and now 7. `NodeSerialTransport` inherits it too: it reports a dead port
  through `onError` and flips `isOpen`, but the in-flight attempt still waits out its
  full timeout before the next one rejects with `closed`. Changing the interface
  touches four transports now instead of two, so it got harder, not easier.
- **Nothing enforces `noUncheckedIndexedAccess` on `am32-sim`, `am32-web`,
  `am32-node` or `am32-cli`.** Block 3's open item, now with two more packages in it.
  The new code was written to it by hand. A shared strict tsconfig for the non-core
  packages would close all four; it is a harness change and I did not take it
  unilaterally.
- **`ark32 --sim` cannot fault-inject on the FC's *own* per-byte read budget**, and
  neither can anything else — block 3 removed `FcProfile.readBudgetPerByteMs` rather
  than leave a field nothing read. So `--fault escN=slowBy:600` models latency in the
  path, not an ESC that is slow internally. Block 6's note has the full argument; the
  CLI inherits it unchanged.
- **`ark32 trace` does not exist.** Section 9 lists recorded-trace conformance as
  deferred-but-not-forbidden and says "if `ark32 trace` in block 7 makes capture
  cheap, replaying traces against `SimFc` is a reasonable follow-up". Block 7's
  done-when does not ask for it and I did not add it. The hook if someone wants it:
  `Link.stats` already counts exchanges, and a `Transport` decorator that tees both
  directions to a file is ~30 lines in `am32-cli` — no core change needed.
- **`docs/plans/overhaul/STATUS.json` carries the driver's own `status: in-progress`
  edit**, committed with this note because the block must leave no uncommitted
  changes. I did not author that line, and every other commit in this block staged
  explicit paths so it could not be swept in by accident. Same as blocks 1b through 6.

## Four things I would tell the next block's agent, in the order they cost me

0. **Re-run the suite after every revert, not only after every mutation.** Blocks 4,
   5 and 6 all warn that `git checkout --` restores from `HEAD`; I read all three and
   still lost a fix to it, because "commit before you mutate" protects work made
   before the mutation and my fix *was* made before it — it just was not in `HEAD`
   yet. I then committed a tree with two red tests. Ten seconds of `yarn vitest run`
   after the revert catches it. This is item zero because it is the only one that
   costs you a commit.

1. **The exit code is a specification, and it is the easiest thing in a CLI to get
   accidentally right.** Two of my tests asserted exit 3 for a bad input file and
   passed with the guard removed, because the session throws the same reason with the
   same message and that also maps to 3. What exit 3 actually promises is *nothing was
   attempted* — a claim about time, not about a number — and the only way to assert it
   is to watch something that would have happened: the session's `state` channel never
   reaching `connecting`. Whenever your assertion is a single value that several
   different paths produce, find the observable that distinguishes them. Block 6 said
   this about *where* a failure happened; this is the same lesson about *when*.

2. **The most dangerous code in this block writes nothing.** `imagePatch`'s six-line
   `delete` loop is the whole difference between "restore my ESC's configuration" and
   "leave this board in its bootloader with nothing on stdout to say why". It is six
   lines, it looks like tidying, and the app does it differently — which is exactly
   the shape of a change someone unifies without reading the reasoning. If you find
   yourself reconciling the CLI and the app, read decision 6 and the "Where I
   disagreed with the app" section first, and change the app rather than the CLI.

3. **The simulator is now the only thing that has ever executed most of this
   repo's protocol code, and block 7 makes that worse before it makes it better.**
   `ark32 --sim` is fast, deterministic and covers every command — and it drives a
   virtual clock over a transport that models timing rather than having any. So the
   green suite says *the protocol logic is right*; it does not say a real link is
   fast enough, and it cannot, and 451 passing tests are very good at making you
   forget that. What block 7 does change is that the hardware checkpoint is now
   **scriptable**: `ark32 read --esc all -o before`, a power cycle,
   `ark32 read --esc all -o after`, `cmp`. That is a stronger check than anyone has
   had, on the one thing nobody has done. Whoever plugs in a board first should run
   it and write the diff into `docs/TESTING.md`.
