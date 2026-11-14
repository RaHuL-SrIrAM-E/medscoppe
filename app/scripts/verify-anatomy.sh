#!/usr/bin/env bash
# Hands-only anatomy workflow check (IWER emulation). Every action is a hand-ray pinch with
# controllers disconnected: select -> info card -> isolate -> show all -> layers -> reset.
# Requires a running dev server (`npx @iwsdk/cli dev up`). Exits non-zero on failure.
set -u
cd "$(dirname "$0")/.."
J() { npx @iwsdk/cli "$@" 2>&1; }
fail=0
check() { if [ "$2" = "1" ]; then echo "PASS  $1"; else echo "FAIL  $1"; fail=1; fi; }
now() { python3 -c "import time;print(int(time.time()*1000))"; }
logs() { J browser logs --input-json "{\"since\":$1,\"pattern\":\"$2\",\"count\":200}" | grep -o "\[$2\] {.*}" | sed 's/\\//g'; }

J browser reload >/dev/null; sleep 9
J xr status | grep -q '"sessionActive": true' || { J xr enter >/dev/null; sleep 3; }
for c in controller-left controller-right; do J xr set-connected --input-json "{\"device\":\"$c\",\"connected\":false}" >/dev/null; done

# World position of a named UI element / entity, from the emulator's target list.
where() { J xr list-targets | python3 -c "
import sys,json
t={x['name']:x['position'] for x in json.load(sys.stdin)['data']['result']['targets']}
p=t.get('$1'); print(json.dumps(p) if p else 'null')"; }
pinch_at() { # $1 = target name
  local p; p=$(where "$1"); [ "$p" = null ] && return 1
  J xr look-at --input-json "{\"device\":\"hand-right\",\"target\":$p}" >/dev/null; sleep .5
  J xr select --input-json '{"device":"hand-right","duration":0.2}' >/dev/null; sleep 1
}

# 1. select a structure on the model
t=$(now); J xr look-at --input-json '{"device":"hand-right","target":{"x":-0.07,"y":1.29,"z":-1.1}}' >/dev/null; sleep .5
J xr select --input-json '{"device":"hand-right","duration":0.2}' >/dev/null; sleep 1.2
sel=$(logs $t intent | grep -o 'SELECT_STRUCTURE","structureId":"[^"]*' | tail -1 | sed 's/.*"//')
[[ "$sel" == respiratory.* ]] && ok=1 || ok=0
check "pinch on the model selects a respiratory structure (got: ${sel:-none})" $ok
card=$(where "Info Card" | python3 -c "import sys,json;p=json.load(sys.stdin);print(1 if p and p['y']>0 else 0)")
check "info card emerges beside the selection (moved out of hiding)" "$card"

# 2. isolate via the card, then show all
t=$(now); pinch_at btn-isolate
logs $t intent | grep -q "ISOLATE_STRUCTURE\",\"structureId\":\"$sel\"" && ok=1 || ok=0; check "pinch Isolate emits ISOLATE_STRUCTURE for the selection" $ok
logs $t state | tail -1 | grep -q "\"iso\":\"$sel\"" && ok=1 || ok=0; check "state: structure isolated" $ok
t=$(now); pinch_at btn-isolate
logs $t intent | grep -q CLEAR_ISOLATION && ok=1 || ok=0; check "pinch Show all emits CLEAR_ISOLATION" $ok

# 3. details toggle
t=$(now); pinch_at btn-details
logs $t state | tail -1 | grep -q '"info":true' && ok=1 || ok=0; check "pinch Details opens the information text" $ok

# 4. layer dock
t=$(now); pinch_at chip-skeletal
logs $t state | tail -1 | grep -q '"skeletal":"active".*"respiratory":"ghost"\|"respiratory":"ghost".*"skeletal":"active"' && ok=1 || ok=0
check "pinch Skeleton: skeletal active, respiratory ghosted" $ok
t=$(now); pinch_at chip-surface
logs $t state | tail -1 | grep -q '"surface":"ghost"' && ok=1 || ok=0; check "pinch Body: body shell shown" $ok
t=$(now); pinch_at chip-reset
logs $t intent | grep -q RESET_VIEW && ok=1 || ok=0; check "pinch Reset emits RESET_VIEW" $ok
logs $t state | tail -1 | grep -q '"respiratory":"active"' && ok=1 || ok=0; check "state: back to respiratory focus" $ok

[ $fail = 0 ] && echo "ALL ANATOMY CHECKS PASSED" || echo "ANATOMY CHECKS FAILED"
exit $fail
