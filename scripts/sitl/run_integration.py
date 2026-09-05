#!/usr/bin/env python3
"""Exercise the production configurator codec against real firmware SITL.

Requires Node 22, installed configurator dependencies, and the firmware's
Python CI requirements. All transport is software UDP/multicast; no serial
device, flight controller, bootloader, or physical ESC is opened.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--firmware', required=True, type=Path, help='ARK32 firmware checkout')
    parser.add_argument('--sitl', type=Path, help='built SITL ELF (default: firmware obj/32.0 ELF)')
    parser.add_argument('--node', default='node', help='Node 22 executable')
    args = parser.parse_args()
    firmware = args.firmware.resolve()
    configurator = Path(__file__).resolve().parents[2]
    binary = (args.sitl or firmware / 'obj' / 'ARK32_AM32_SITL_CAN_32.0.elf').resolve()
    if not binary.is_file():
        parser.error(f'Build firmware SITL first: make -C {firmware} AM32_SITL_CAN')
    schema_path = firmware / 'schema' / 'eeprom.json'
    for path in (firmware / 'Mcu' / 'SITL', firmware / 'Mcu' / 'SITL' / 'tests'):
        sys.path.insert(0, str(path))
    import dronecan
    from sitl_gui_backend import EepromClient
    from sitl_harness import Sitl, free_mcast_group
    from test_eeprom_schema import _fetch, _write, _wait_for_esc, zero_throttle_can
    from test_params import _get_param, _request_wait, _set_param

    subprocess.run([args.node, str(configurator / 'scripts' / 'gen-eeprom-layout.ts')],
                   cwd=configurator, check=True)
    with tempfile.TemporaryDirectory(prefix='ark32-schema-integration-') as temporary:
        workdir = Path(temporary)
        bridge = workdir / 'codec.mjs'
        subprocess.run([
            str(configurator / 'node_modules' / '.bin' / 'esbuild'),
            str(configurator / 'scripts' / 'sitl' / 'schema-codec.ts'),
            '--bundle', '--platform=node', '--format=esm', f'--outfile={bridge}',
        ], cwd=configurator, check=True)

        def codec(image, **options):
            request = dict(schemaPath=str(schema_path), image=list(image), **options)
            result = subprocess.run([args.node, str(bridge)], input=json.dumps(request),
                                    text=True, capture_output=True, check=True, timeout=20)
            return json.loads(result.stdout)

        uri = f'mcast:{free_mcast_group()}'
        start_args = ['--node-id', '10', '--eeprom', 'schema-integration.bin']
        # Multicast or DroneCAN failure is a test failure, never a skip.
        with zero_throttle_can(uri):
            with Sitl(str(binary), extra_args=start_args, can_uri=uri, workdir=str(workdir)) as sitl:
                ready, found = _wait_for_esc(uri, our_id=120)
                try:
                    assert 10 in found, sitl.log_tail()
                finally:
                    ready.close()
                client = EepromClient('127.0.0.1', sitl.state_port)
                base = bytearray(_fetch(client))
                assert base[1] == 3 and base[3:5] == bytes([32, 0]), base[:5]
                base[13:17] = bytes([0x13, 0xA4, 0x55, 0xE6])
                base[184:192] = bytes([0xFF, 0x00, 0x20, 0x80, 0xAA, 0x55, 0xC8, 0xF1])
                _write(client, 0, base)
                base = _fetch(client)
                patched = codec(base, displayPatch={'MOTOR_KV': 1020}, rawPatch={'MOTOR_POLES': 128})
                assert patched['context'] == {'layout': 3, 'firmware': '32.0'}
                assert patched['image'][26:28] == [25, 128]
                assert patched['display']['MOTOR_KV'] == 1020
                changed = {i for i, (before, after) in enumerate(zip(base, patched['image'])) if before != after}
                assert changed <= {26, 27}, changed
                _write(client, 0, patched['image'])
                actual = _fetch(client)
                assert actual == bytes(patched['image']), 'firmware rewrote a supported codec patch'

                defaults = codec(actual, defaults=True)
                for start, end in ((0, 5), (13, 17), (176, 192)):
                    assert bytes(defaults['image'][start:end]) == actual[start:end]
                assert defaults['image'][43:45] == [255, 0], 'defaults must use canonical off writes'
                _write(client, 0, defaults['image'])
                after_defaults = _fetch(client)
                assert after_defaults == bytes(defaults['image'])
                assert codec(after_defaults)['settings']['CURRENT_LIMIT'] == 0

                # v2 metadata must keep the legacy name bytes, including when
                # callers submit v3-only keys. This image is codec-only: running
                # firmware would legitimately migrate it during its next load.
                legacy = bytearray(actual)
                legacy[1], legacy[3], legacy[4] = 2, 2, 16
                legacy[5:17] = b'legacy-name!'
                old = codec(legacy, rawPatch={'CURRENT_P': 19, 'MOTOR_KV': 25})
                assert bytes(old['image'][5:17]) == legacy[5:17]
                assert 'CURRENT_P' not in old['settings']

                # UDP cmd 6 already saved defaults. Only DroneCAN changes this
                # next value, so a successful restart proves ExecuteOpcode SAVE.
                node, found = _wait_for_esc(uri, our_id=121)
                try:
                    assert 10 in found, sitl.log_tail()
                    assert _set_param(node, 10, 'MOTOR_KV', 1420) is not None
                    req = dronecan.uavcan.protocol.param.ExecuteOpcode.Request()
                    req.opcode = req.OPCODE_SAVE
                    response = _request_wait(node, 10, req)
                    assert response is not None and response.ok, 'DroneCAN SAVE failed'
                finally:
                    node.close()

            with Sitl(str(binary), extra_args=start_args, can_uri=uri, workdir=str(workdir)) as restarted:
                node, found = _wait_for_esc(uri, our_id=122)
                try:
                    assert 10 in found, restarted.log_tail()
                    response = _get_param(node, 10, 'MOTOR_KV')
                    assert response is not None and int(response.value.integer_value) == 1420
                    persisted = _fetch(EepromClient('127.0.0.1', restarted.state_port))
                    assert persisted[26] == 35
                    assert codec(persisted)['display']['MOTOR_KV'] == 1420
                    assert persisted[176:192] == actual[176:192], (persisted[176:192].hex(), actual[176:192].hex())
                    assert persisted[13:17] == actual[13:17]
                finally:
                    node.close()
        print(json.dumps({
            'result': 'PASS',
            'schema_sha256': hashlib.sha256(schema_path.read_bytes()).hexdigest(),
            'firmware': str(binary),
            'checks': ['live codec roundtrip', 'display conversion', '128 poles',
                       'defaults preservation', 'v2 field gates', 'DroneCAN SAVE and restart'],
        }, indent=2))


if __name__ == '__main__':
    main()
