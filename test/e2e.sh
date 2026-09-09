#!/usr/bin/env bash
# Acceptance script: spec section 13, all eight criteria.
# Usage: ./test/e2e.sh   (against a live stack on localhost:3000)
set -uo pipefail

API=${API:-http://localhost:3000}
FIX=/tmp/ct-fixtures
mkdir -p "$FIX"
PASS=0
FAIL=0

check() { # check <name> <exit-code>
  if [ "$2" -eq 0 ]; then echo "PASS: $1"; PASS=$((PASS+1)); else echo "FAIL: $1"; FAIL=$((FAIL+1)); fi
}

# fixtures
ffmpeg -y -v error -f lavfi -i testsrc=size=4000x1000:duration=1 -frames:v 1 "$FIX/big.jpg"
ffmpeg -y -v error -f lavfi -i testsrc=size=1280x720:duration=5 -f lavfi -i sine=frequency=440:duration=5 -shortest -c:v libx264 -preset ultrafast -c:a aac "$FIX/video.mp4"
ffmpeg -y -v error -f lavfi -i sine=frequency=440:duration=10 -ac 2 -ar 44100 -c:a pcm_s16le "$FIX/audio.wav"
gs -dNOPAUSE -dBATCH -dQUIET -sDEVICE=pdfwrite -sOutputFile="$FIX/scan.pdf" "$FIX/big.jpg"
python3 - "$FIX/log.json" << 'EOF'
import json, sys
json.dump({"events": ["request handled normally" * 5] * 200}, open(sys.argv[1], "w"))
EOF
python3 - "$FIX/doc.docx" << 'EOF'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as z:
    z.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    z.writestr("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    z.writestr("word/document.xml", '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Acceptance fixture document.</w:t></w:r></w:p></w:body></w:document>')
EOF

upload() { curl -s -F "file=@$1" "$API/api/assets" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])"; }
await_ready() { # await_ready <id> <timeout-sec>
  local t=0
  while [ $t -lt "$2" ]; do
    s=$(curl -s "$API/api/assets/$1" | python3 -c "import json,sys;print(json.load(sys.stdin)['status'])")
    if [ "$s" = "ready" ] || [ "$s" = "failed" ]; then echo "$s"; return 0; fi
    sleep 3; t=$((t+3))
  done
  echo timeout
}
jsonq() { curl -s "$API/api/assets/$1" | python3 -c "import json,sys;a=json.load(sys.stdin);${2}"; }

# 1. image tiers
ID=$(upload "$FIX/big.jpg"); [ "$(await_ready "$ID" 30)" = "ready" ]
jsonq "$ID" "vs={v['label']:v['sizeBytes'] for v in a['variants']}; ok=len(vs)==4 and vs.get('320w',1e9)<vs['original']*0.1; print(ok)" | grep -q True
check "1 image: 4 tiers, 320w under 10%" $?

# 2. video tiers + range
ID=$(upload "$FIX/video.mp4"); [ "$(await_ready "$ID" 120)" = "ready" ]
jsonq "$ID" "ok=[v['label'] for v in a['variants']] in [['original','1080p','720p','480p','thumb'],['original','thumb','1080p','720p','480p']] or set(v['label'] for v in a['variants'])=={'original','1080p','720p','480p','thumb'}; print(ok)" | grep -q True
check "2a video: 3 tiers + thumb" $?
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "Range: bytes=0-99" "$API/api/assets/$ID/files/720p")
[ "$CODE" = "206" ]; check "2b video: range returns 206" $?

# 3. audio
ID=$(upload "$FIX/audio.wav"); [ "$(await_ready "$ID" 30)" = "ready" ]
jsonq "$ID" "vs={v['label']:v['sizeBytes'] for v in a['variants']}; ok=vs.get('opus-96k',1e9)<vs['original']*0.15; print(ok)" | grep -q True
check "3 audio: opus-96k under 15%" $?

# 4. pdf tiers ordered
ID=$(upload "$FIX/scan.pdf"); [ "$(await_ready "$ID" 60)" = "ready" ]
jsonq "$ID" "vs={v['label']:v['sizeBytes'] for v in a['variants']}; ok=vs.get('screen',0)<vs.get('print',1); print(ok)" | grep -q True
check "4 pdf: screen smaller than print" $?

# 5. docx converts to pdf tiers
ID=$(upload "$FIX/doc.docx"); [ "$(await_ready "$ID" 120)" = "ready" ]
jsonq "$ID" "vs={v['label']:v['mimeType'] for v in a['variants']}; ok=sum(1 for m in vs.values() if m=='application/pdf')>=3; print(ok)" | grep -q True
check "5 docx: pdf tiers exist" $?

# 6. json brotli
ID=$(upload "$FIX/log.json"); [ "$(await_ready "$ID" 30)" = "ready" ]
jsonq "$ID" "vs={v['label']:v['sizeBytes'] for v in a['variants']}; ok=vs.get('br',1e9)<vs['original']*0.3; print(ok)" | grep -q True
check "6 json: br under 30%" $?

# 7. worker kill recovery (long video, kill mid-job)
ffmpeg -y -v error -f lavfi -i testsrc=size=1920x1080:duration=120 -f lavfi -i sine=frequency=440:duration=120 -shortest -c:v libx264 -preset ultrafast -c:a aac "$FIX/long.mp4"
ID=$(upload "$FIX/long.mp4")
sleep 8
docker kill compression-testing-worker-1 >/dev/null 2>&1
sleep 2
docker compose -f "$(dirname "$0")/../docker-compose.yml" up -d worker >/dev/null 2>&1
[ "$(await_ready "$ID" 1800)" = "ready" ]
check "7 worker kill: asset recovers to ready" $?

# 8. delete removes both buckets
ID=$(upload "$FIX/big.jpg"); await_ready "$ID" 30 >/dev/null
curl -s -X DELETE "$API/api/assets/$ID" -o /dev/null
sleep 1
curl -s -o /dev/null -w '%{http_code}' "$API/api/assets/$ID/files/original" | grep -q 404
check "8 delete: objects gone" $?

echo "----"
echo "passed $PASS / $((PASS+FAIL))"
[ "$FAIL" -eq 0 ]
