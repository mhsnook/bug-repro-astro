#!/usr/bin/env bash
# One matrix row. Usage: matrix-test.sh <label> <port>
# Run from the repro repo root. Prints a fixed-shape report so rows compare.
LABEL="$1"
PORT="${2:-4402}"
LOG=.astro/dev.log

say() { printf '%s\n' "$*"; }

say "############ $LABEL ############"
say "--- versions ---"
node -e 'const r=p=>{try{return require(process.cwd()+"/node_modules/"+p+"/package.json").version}catch(e){return "MISSING"}};
for (const p of ["astro","emdash","@astrojs/cloudflare","@emdash-cms/cloudflare"]) console.log("  "+p.padEnd(24), r(p));'

timeout 30 npx astro dev stop >/dev/null 2>&1
rm -rf .astro .wrangler node_modules/.vite

# --- start attempt 1 ---
OUT1=$(timeout 150 npx astro dev --port "$PORT" 2>&1)
PID=$(printf '%s' "$OUT1" | grep -oE 'pid [0-9]+' | grep -oE '[0-9]+' | head -1)
if [ -z "$PID" ]; then
  say "  startup attempt 1: FAILED"
  say "  stale-chunk error present: $(grep -c 'does not exist at' $LOG 2>/dev/null || echo 0)"
  ATTEMPT1=fail
  OUT2=$(timeout 150 npx astro dev --port "$PORT" 2>&1)
  PID=$(printf '%s' "$OUT2" | grep -oE 'pid [0-9]+' | grep -oE '[0-9]+' | head -1)
  [ -z "$PID" ] && { say "  startup attempt 2: FAILED — giving up"; say ""; exit 0; }
  say "  startup attempt 2: ok (pid $PID)"
else
  ATTEMPT1=ok
  say "  startup attempt 1: ok (pid $PID)"
fi

curl -s -o /dev/null --retry 25 --retry-delay 1 --retry-connrefused --max-time 150 "http://127.0.0.1:$PORT/" >/dev/null 2>&1

say "--- setup + seed ---"
curl -sL -o /dev/null -w "  dev-bypass -> %{http_code} in %{time_total}s\n" --max-time 300 \
  "http://127.0.0.1:$PORT/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin" 2>/dev/null

say "--- admin loads ---"
for i in 1 2 3; do
  printf "  /_emdash/admin #%s -> " "$i"
  curl -sL -o /dev/null -w "%{http_code} in %{time_total}s\n" --max-time 150 \
    "http://127.0.0.1:$PORT/_emdash/admin" 2>/dev/null || say "DEAD/TIMEOUT"
done

say "--- home page ---"
for i in 1 2 3 4; do
  printf "  / #%s -> " "$i"
  curl -s -o /dev/null -w "%{http_code} in %{time_total}s\n" --max-time 60 \
    "http://127.0.0.1:$PORT/" 2>/dev/null || say "DEAD/TIMEOUT"
done

say "--- idle process ---"
ps -o pid,pcpu,rss,etime --no-headers -p "$PID" 2>/dev/null | sed 's/^/  /' || say "  process gone"

say "--- log signatures ---"
printf "  startup attempt 1:            %s\n" "$ATTEMPT1"
for pat in "does not exist at" "optimized dependencies changed" "program reload" "getBackend" "object-cache" "Unable to resolve"; do
  printf "  %-30s %s\n" "$pat" "$(grep -c "$pat" $LOG 2>/dev/null | head -1)"
done
say "  deps discovered late:"
grep -oE "dependency optimized: [^\"]*" $LOG 2>/dev/null | sort -u | sed 's/^/    /' || say "    none"
printf "  log size: %s bytes\n" "$(stat -c %s $LOG 2>/dev/null || echo 0)"

timeout 30 npx astro dev stop >/dev/null 2>&1
say ""
