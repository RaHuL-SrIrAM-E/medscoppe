#!/usr/bin/env bash
# Hands-only consultation check (IWER emulation, controllers disconnected). Every action is a hand-ray pinch:
# start -> pause -> resume -> scripted replay completes -> select a bead -> explicit confirm -> close -> new session -> end.
# Requires a running dev server (`npx @iwsdk/cli dev up --headless`).
# MODE is explicit, never silently defaulted:
#   MODE=offline (default)  no backend configured: the app makes no request and runs the labelled offline replay.
#   MODE=backend            needs the API on :8000 AND the dev server started with VITE_API_BASE_URL=http://localhost:8000
#                           (`VITE_API_BASE_URL=http://localhost:8000 npx @iwsdk/cli dev up --headless`); the script
#                           then FAILS unless the session reports the backend as its source.
# The scripted consultation runs in real time (about 30 s). Exits non-zero on failure.
set -u
MODE=${MODE:-offline}
cd "$(dirname "$0")/.."
J() { npx @iwsdk/cli "$@" 2>&1; }
fail=0
check() { if [ "$2" = "1" ]; then echo "PASS  $1"; else echo "FAIL  $1"; fail=1; fi; }
now() { python3 -c "import time;print(int(time.time()*1000))"; }
logs() { J browser logs --input-json "{\"since\":$1,\"pattern\":\"$2\",\"count\":200}" | grep -o "\[$2\] {.*}" | sed 's/\\//g'; }

J browser reload >/dev/null; sleep 9
J xr status | grep -q '"sessionActive": true' || { J xr enter >/dev/null; sleep 3; }
for c in controller-left controller-right; do J xr set-connected --input-json "{\"device\":\"$c\",\"connected\":false}" >/dev/null; done

where() { J xr list-targets | python3 -c "
import sys,json
t={x['name']:x['position'] for x in json.load(sys.stdin)['data']['result']['targets']}
p=t.get('$1'); print(json.dumps(p) if p and p['y']>-5 else 'null')"; }
pinch_at() {
  local p; p=$(where "$1"); [ "$p" = null ] && return 1
  J xr look-at --input-json "{\"device\":\"hand-right\",\"target\":$p}" >/dev/null; sleep .5
  J xr select --input-json '{"device":"hand-right","duration":0.2}' >/dev/null; sleep 1
}
last() { logs "$1" consult | tail -1; }
wait_for() { # $1 since, $2 pattern, $3 timeout s
  local end=$((SECONDS+$3))
  while [ $SECONDS -lt $end ]; do logs "$1" consult | grep -q "$2" && return 0; sleep 2; done; return 1
}

# 0. before anything: labelled, empty
t0=$(( $(now) - 25000 ))
start_before=$(logs $t0 consult | tail -1)
[ -z "$start_before" ] && ok=1 || { echo "$start_before" | grep -q '"beads":\[\]' && ok=1 || ok=0; }
check "scene starts with no observation beads (no consult state change before Start)" $ok

# 1. start by hand
t=$(now); pinch_at consult-btn-primary
logs $t intent | grep -q 'START_CONSULTATION","source":"hand\|START_CONSULTATION"},"source":"hand' && ok=1 || ok=0; check "pinch Start emits START_CONSULTATION from the hand" $ok
wait_for $t '"life":"LISTENING"' 12 && ok=1 || ok=0; check "session reaches LISTENING" $ok
last $t | grep -q 'RECORDED REPLAY' && ok=1 || ok=0; check "extraction is labelled RECORDED REPLAY while running" $ok
if [ "$MODE" = backend ]; then want=BACKEND; else want=OFFLINE_FIXTURE; fi
last $t | grep -q "\"src\":\"$want\"" && ok=1 || ok=0; check "extraction source is $want (MODE=$MODE)" $ok

# 2. pause and resume by hand
sleep 3
t2=$(now); pinch_at consult-btn-primary
wait_for $t2 '"life":"PAUSED"' 8 && ok=1 || ok=0; check "pinch Pause pauses the session" $ok
t3=$(now); pinch_at consult-btn-primary
wait_for $t3 '"life":"LISTENING"' 8 && ok=1 || ok=0; check "pinch Resume resumes it" $ok

# 3. the replay completes and builds the four beads from the real store
wait_for $t '"life":"COMPLETE"' 60 && ok=1 || ok=0; check "scripted replay completes" $ok
fin=$(last $t)
echo "$fin" | python3 -c "
import sys,json,re
l=sys.stdin.read(); d=json.loads(l.split('] ',1)[1])
sys.exit(0 if sorted(d['beads'])==['Cough','Dyspnoea','Fever','No chest pain'] else 1)" && ok=1 || ok=0
check "beads: Cough, Fever, Dyspnoea, No chest pain (from the session, not hard-coded)" $ok
logs $t consult | grep -q DOCTOR_CONFIRMED && ok=0 || ok=1; check "nothing is DOCTOR_CONFIRMED after the replay" $ok

# 4. select a bead, confirm explicitly, close
t=$(now); pinch_at consult-bead-0
logs $t intent | grep -q 'SELECT_OBSERVATION' && ok=1 || ok=0; check "pinch a bead emits SELECT_OBSERVATION" $ok
last $t | grep -q '"sel":"obs_' && ok=1 || ok=0; check "the observation card opens (selection set)" $ok
logs $t consult | grep -q DOCTOR_CONFIRMED && ok=0 || ok=1; check "opening the card does not confirm anything" $ok
t=$(now); pinch_at obs-btn-confirm
logs $t intent | grep -q 'CONFIRM_OBSERVATION' && ok=1 || ok=0; check "pinch Confirm emits CONFIRM_OBSERVATION" $ok
last $t | grep -q '"origins":\["DOCTOR_CONFIRMED","PATIENT","PATIENT","PATIENT"\]' && ok=1 || ok=0; check "exactly the chosen observation becomes DOCTOR_CONFIRMED" $ok
t=$(now); pinch_at obs-btn-correct; pinch_at obs-opt-0
logs $t intent | grep -q 'CORRECT_OBSERVATION' && ok=1 || ok=0; check "pinch Correct then Mark absent emits CORRECT_OBSERVATION" $ok
t=$(now); pinch_at obs-btn-note; pinch_at obs-opt-0
logs $t intent | grep -q 'ANNOTATE_OBSERVATION' && ok=1 || ok=0; check "pinch Note then a preset emits ANNOTATE_OBSERVATION" $ok
t=$(now); pinch_at obs-btn-close
last $t | grep -q '"sel":null' && ok=1 || ok=0; check "pinch Close dismisses the card" $ok

# 5. a new session starts fresh, then End by hand
t=$(now); pinch_at consult-btn-primary
wait_for $t '"life":"LISTENING"' 12 && ok=1 || ok=0; check "pinch New session starts a fresh run" $ok
logs $t consult | head -3 | grep -q '"beads":\[\]' && ok=1 || ok=0; check "the new run starts with no beads" $ok
sleep 3
t=$(now); pinch_at consult-btn-end
wait_for $t '"life":"ENDED"' 8 && ok=1 || ok=0; check "pinch End ends the session" $ok

[ $fail = 0 ] && echo "ALL CONSULTATION CHECKS PASSED" || echo "CONSULTATION CHECKS FAILED"
exit $fail
