#!/usr/bin/env bash
# Hands-only check that the VISIBLE observation card updates (IWER emulation, controllers disconnected).
# Every action is a hand-ray pinch on a real spatial control; every assertion reads the rendered UIKit elements of the
# card (`ui inspect`: the live text and displayed state of #confirm, #severity, #revision, #note, #evidence), not the app
# state and not an emitted intent. Needs a running dev server (`npx @iwsdk/cli dev up --headless`); offline replay, real time (~1 min).
set -u
cd "$(dirname "$0")/.."
J() { npx @iwsdk/cli "$@" 2>&1; }
fail=0
check() { if [ "$2" = "1" ]; then echo "PASS  $1"; else echo "FAIL  $1  ${3:-}"; fail=1; fi; }

J browser reload >/dev/null; sleep 9
J xr status | grep -q '"sessionActive": true' || { J xr enter >/dev/null; sleep 3; }
for c in controller-left controller-right; do J xr set-connected --input-json "{\"device\":\"$c\",\"connected\":false}" >/dev/null; done

where() { J xr list-targets | python3 -c "
import sys,json
t={x['name']:x['position'] for x in json.load(sys.stdin)['data']['result']['targets']}
p=t.get('$1'); print(json.dumps(p) if p and p['y']>-5 else 'null')"; }
pinch_at() { local p; p=$(where "$1"); [ "$p" = null ] && return 1
  J xr look-at --input-json "{\"device\":\"hand-right\",\"target\":$p}" >/dev/null; sleep .5
  J xr select --input-json '{"device":"hand-right","duration":0.2}' >/dev/null; sleep 1.3; }
IDX=$(J ecs find --input-json '{"namePattern":"^Observation Card$"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['result']['entities'][0]['entityIndex'])")
# text and displayed flag of a rendered card element: prints "<displayed>|<text>"
ui() { J ui inspect --input-json "{\"entityIndex\":$IDX,\"selector\":\"#$1\"}" | python3 -c "
import sys,json
e=json.load(sys.stdin)['data']['result']['elements']
print(('1' if e and e[0]['state']['displayed'] else '0')+'|'+(e[0].get('text','') if e else ''))"; }
has() { local v; v=$(ui "$1"); [[ "$v" == 1\|* && "$v" == *"$2"* ]]; }

pinch_at consult-btn-primary
for i in $(seq 1 30); do sleep 2; [ "$(ui title | cut -c1-2)" != "" ] && J browser logs --input-json '{"count":30}' | grep -q '"life":"COMPLETE"' && break; done
sleep 1
pinch_at consult-bead-2
has title Dyspnoea && ok=1 || ok=0; check "pinching the Dyspnoea bead shows its card (#title)" $ok "$(ui title)"
ev0=$(ui evidence)
[[ "$ev0" == *"walking upstairs"* ]] && ok=1 || ok=0; check "the card shows the exact evidence quote" $ok "$ev0"
has confirm "Not confirmed by a doctor" && ok=1 || ok=0; check "before review the card says: Not confirmed by a doctor" $ok "$(ui confirm)"

pinch_at obs-btn-correct
has presence "Correct: choose one" && ok=1 || ok=0; check "pinch Correct: the card shows the correction choices" $ok "$(ui presence)"
has obs-opt-2-label "Severity: Moderate" && ok=1 || ok=0; check "option 3 reads 'Severity: Moderate'" $ok "$(ui obs-opt-2-label)"
pinch_at obs-opt-2
has confirm "Corrected by a doctor (explicit action)" && ok=1 || ok=0; check "after pinching it the card says: Corrected by a doctor (explicit action)" $ok "$(ui confirm)"
has severity "Severity: Moderate" && ok=1 || ok=0; check "the card shows 'Severity: Moderate'" $ok "$(ui severity)"
has revision "Revision 2" && ok=1 || ok=0; check "the card shows 'Revision 2' and that earlier revisions are kept" $ok "$(ui revision)"
has source "doctor-confirmed" && ok=1 || ok=0; check "the card source reads doctor-confirmed (an explicit action)" $ok "$(ui source)"
[ "$(ui evidence)" = "$ev0" ] && ok=1 || ok=0; check "the original evidence quote is unchanged after the correction" $ok "$(ui evidence)"

pinch_at obs-btn-note
has presence "Add a short note" && ok=1 || ok=0; check "pinch Note: the card shows the preset notes" $ok "$(ui presence)"
has obs-opt-0-label "Needs follow-up" && ok=1 || ok=0; check "option 1 reads 'Needs follow-up'" $ok "$(ui obs-opt-0-label)"
pinch_at obs-opt-0
has note "Doctor's note: Needs follow-up" && ok=1 || ok=0; check "after pinching it the card shows: Doctor's note: Needs follow-up" $ok "$(ui note)"
has severity "Severity: Moderate" && ok=1 || ok=0; check "the severity correction is still shown after the note" $ok "$(ui severity)"
has revision "Revision 3" && ok=1 || ok=0; check "the card shows 'Revision 3' (the note is its own revision)" $ok "$(ui revision)"
[ "$(ui evidence)" = "$ev0" ] && ok=1 || ok=0; check "the original evidence quote is still unchanged after the note" $ok "$(ui evidence)"

[ $fail = 0 ] && echo "ALL CARD CHECKS PASSED" || echo "CARD CHECKS FAILED"
exit $fail
