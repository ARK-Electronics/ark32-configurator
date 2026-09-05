# Configurator and firmware integration

This test runs the production TypeScript EEPROM resolver, defaults and codec
against the actual ARK32 firmware SITL process. It uses the existing Python
SITL harness and software UDP/multicast DroneCAN. No hardware is required.

Use Node 22 and install configurator dependencies with `corepack yarn install
--immutable`. In a Python environment, install the firmware requirements:

```sh
python -m pip install -r ../AM32/Mcu/SITL/requirements-ci.txt jsonschema
make -C ../AM32 AM32_SITL_CAN
python scripts/sitl/run_integration.py --firmware ../AM32
```

Both checkout paths may differ; `--firmware` names the firmware checkout and
`--sitl` can select an explicit ELF. Run alongside neither another integration
instance nor the firmware CAN suite: the harness cycles a finite set of multicast
buses. The runner uses temporary EEPROM files and free UDP state/input ports.

The test checks byte preservation, KV display conversion, the 128-pole range,
canonical disabled defaults, v2 field gates, and DroneCAN SAVE followed by a
process restart. It loads the firmware checkout's current schema into the real
configurator codec, so it also checks runtime consumption of external metadata.
Unavailable multicast or missing DroneCAN dependencies fail this acceptance test.

The ordinary configurator suite remains independent of a firmware checkout.
The separate `Firmware SITL integration` CI workflow checks out a pinned firmware
commit and runs this same command on every PR. Update its `ARK32_FIRMWARE_REF`
deliberately when moving the integration test to another firmware revision.
