#!/usr/bin/env bash
# Hands-only regression check against the running dev server (IWER emulation).
# Requires: `npx @iwsdk/cli dev up` and a ready managed browser. Exits non-zero on failure.
set -u
cd "$(dirname "$0")/.."
J() { npx @iwsdk/cli "$@" 2>&1; }
fail=0
check() { if [ "$2" = "1" ]; then echo "PASS  $1"; else echo "FAIL  $1"; fail=1; fi; }

J xr status | grep -q '"sessionActive": true' || { J xr enter >/dev/null; sleep 3; }
mode=$(J xr get-device-state | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['result']['inputMode'])")
check "IWER input mode is hand (got: $mode)" "$([ "$mode" = hand ] && echo 1 || echo 0)"
feat=$(J xr status | grep -c '"hand-tracking"')
check "hand-tracking session feature enabled" "$([ "$feat" -ge 1 ] && echo 1 || echo 0)"
# IWER keeps controllers "connected" at device level even in hand mode, so disconnect
# them outright: everything below must pass with no controller available at all.
for c in controller-left controller-right; do
  J xr set-connected --input-json "{\"device\":\"$c\",\"connected\":false}" >/dev/null
done
ctrl=$(J xr get-device-state | python3 -c "import sys,json;c=json.load(sys.stdin)['data']['result']['controllers'];print(sum(1 for v in c.values() if isinstance(v,dict) and v.get('connected')))")
check "controllers disconnected (workflow runs hands-only)" "$([ "$ctrl" = 0 ] && echo 1 || echo 0)"

aim() { J xr look-at --input-json "{\"device\":\"hand-$1\",\"target\":{\"x\":$2,\"y\":$3,\"z\":-1.3}}" >/dev/null; sleep .5; }
pin() { J xr set-select-value --input-json "{\"device\":\"hand-$1\",\"value\":$2,\"duration\":0.15}" >/dev/null; }
intents() { J browser logs --input-json "{\"since\":$1,\"pattern\":\"\\\\[intent\\\\]\",\"count\":200}" | grep -o '\[intent\] {.*}' | sed 's/\\//g'; }
now() { python3 -c "import time;print(int(time.time()*1000))"; }

# 1. Pinch-tap on the skull (world y ~1.51) -> SELECT_STRUCTURE
t=$(now); aim right 0 1.51; pin right 1; sleep .15; pin right 0; sleep .8
out=$(intents "$t")
echo "$out" | grep -q '"SELECT_STRUCTURE","structureId":"skull"},"source":"hand"' && ok=1 || ok=0
check "right-hand pinch-tap on skull emits SELECT_STRUCTURE(skull) from 'hand'" $ok

# 2. Pinch-hold and sweep right -> ROTATE_MODEL start/end with positive yaw
t=$(now); aim right 0 1.3; pin right 1; sleep .4
J xr look-at --input-json '{"device":"hand-right","target":{"x":0.5,"y":1.3,"z":-1.3}}' >/dev/null; sleep .8; pin right 0; sleep .8
out=$(intents "$t")
echo "$out" | grep -q 'ROTATE_MODEL","phase":"start"' && ok=1 || ok=0; check "right-hand hold+sweep emits ROTATE_MODEL start" $ok
echo "$out" | grep -qE 'ROTATE_MODEL","phase":"end","yawDegrees":[0-9]' && ok=1 || ok=0; check "...and ROTATE_MODEL end with positive yaw" $ok
echo "$out" | grep -q SELECT_STRUCTURE && ok=0 || ok=1; check "a rotation does not also select a structure" $ok

# 3. Left hand sweep left -> negative yaw
t=$(now); aim left 0 1.3; pin left 1; sleep .4
J xr look-at --input-json '{"device":"hand-left","target":{"x":-0.5,"y":1.3,"z":-1.3}}' >/dev/null; sleep .8; pin left 0; sleep .8
intents "$t" | grep -qE 'ROTATE_MODEL","phase":"end","yawDegrees":-[0-9]' && ok=1 || ok=0
check "left-hand hold+sweep emits ROTATE_MODEL end with negative yaw" $ok

[ $fail = 0 ] && echo "ALL HAND CHECKS PASSED" || echo "HAND CHECKS FAILED"
exit $fail
