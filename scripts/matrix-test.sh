#!/usr/bin/env bash
# One matrix row. Usage: matrix-test.sh <label> <port>
# Run from the repro repo root. Prints a fixed-shape report so rows compare.
#
# Read the health verdict at the bottom before comparing any timing. A setup
# whose content never loads serves near-empty pages and looks several times
# faster than a working one.
#
# Two things are NOT symptoms. Both appear on healthy setups:
#   - "[setup-dev-bypass] Seed applied: 0 collections, 0 fields"
#     Auto-seeded default collections runs first, so seed.json applies nothing.
#   - GET /_emdash/admin returning 302. That is a redirect to sign-in.
LABEL="$1"
PORT="${2:-4402}"
LOG=.astro/dev.log

# Healthy content pages measured ~36,900 bytes; broken ones ~204. Anything
# under this is a shell, not a page.
EMPTY_THRESHOLD=1000

say() { printf '%s\n' "$*"; }

# probe <path> <max-time> <follow-redirects: yes|no>
# Echoes "<status> <seconds> <bytes>".
probe() {
	local path="$1" maxtime="$2" follow="$3" flags="-s"
	[ "$follow" = "yes" ] && flags="-sL"
	curl $flags -o /dev/null -w '%{http_code} %{time_total} %{size_download}' \
		--max-time "$maxtime" "http://127.0.0.1:$PORT$path" 2>/dev/null || echo "000 timeout 0"
}

say "############ $LABEL ############"
say "--- versions ---"
node -e 'const r=p=>{try{return require(process.cwd()+"/node_modules/"+p+"/package.json").version}catch(e){return "MISSING"}};
for (const p of ["astro","emdash","@astrojs/cloudflare","@emdash-cms/cloudflare"]) console.log("  "+p.padEnd(24), r(p));'

timeout 30 npx astro dev stop >/dev/null 2>&1
# D1 persists in .wrangler/state/v3/d1 inside the project, so this empties the
# database. There is no global miniflare state.
rm -rf .astro .wrangler node_modules/.vite

# --- start, with one retry: startup fails intermittently on some setups ---
OUT=$(timeout 150 npx astro dev --port "$PORT" 2>&1)
PID=$(printf '%s' "$OUT" | grep -oE 'pid [0-9]+' | grep -oE '[0-9]+' | head -1)
if [ -z "$PID" ]; then
	say "  startup attempt 1: FAILED"
	say "  stale-chunk error present: $(grep -c 'does not exist at' $LOG 2>/dev/null | head -1)"
	ATTEMPT1=fail
	OUT=$(timeout 150 npx astro dev --port "$PORT" 2>&1)
	PID=$(printf '%s' "$OUT" | grep -oE 'pid [0-9]+' | grep -oE '[0-9]+' | head -1)
	[ -z "$PID" ] && { say "  startup attempt 2: FAILED — giving up"; say ""; exit 0; }
	say "  startup attempt 2: ok (pid $PID)"
else
	ATTEMPT1=ok
	say "  startup attempt 1: ok (pid $PID)"
fi

curl -s -o /dev/null --retry 25 --retry-delay 1 --retry-connrefused --max-time 150 \
	"http://127.0.0.1:$PORT/" >/dev/null 2>&1

say "--- setup + seed ---"
read -r BYPASS_STATUS BYPASS_TIME BYPASS_BYTES <<<"$(probe \
	"/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin" 300 yes)"
printf "  dev-bypass       status=%s  time=%ss  bytes=%s\n" \
	"$BYPASS_STATUS" "$BYPASS_TIME" "$BYPASS_BYTES"

say "--- content pages (the health check reads these) ---"
MIN_BYTES=""
for p in "/" "/posts"; do
	read -r ST TM BY <<<"$(probe "$p" 120 no)"
	printf "  %-14s status=%s  time=%ss  bytes=%s\n" "$p" "$ST" "$TM" "$BY"
	case "$BY" in ''|*[!0-9]*) BY=0 ;; esac
	if [ -z "$MIN_BYTES" ] || [ "$BY" -lt "$MIN_BYTES" ]; then MIN_BYTES="$BY"; fi
done

say "--- admin loads ---"
for i in 1 2 3; do
	read -r ST TM BY <<<"$(probe "/_emdash/admin" 150 yes)"
	printf "  #%s               status=%s  time=%ss  bytes=%s\n" "$i" "$ST" "$TM" "$BY"
done

say "--- home page, repeated ---"
for i in 1 2 3 4; do
	read -r ST TM BY <<<"$(probe "/" 60 no)"
	printf "  #%s               status=%s  time=%ss  bytes=%s\n" "$i" "$ST" "$TM" "$BY"
done

say "--- idle process ---"
ps -o pid,pcpu,rss,etime --no-headers -p "$PID" 2>/dev/null | sed 's/^/  /' || say "  process gone"

say "--- log signatures ---"
printf "  startup attempt 1:            %s\n" "$ATTEMPT1"
for pat in "does not exist at" "optimized dependencies changed" "program reload" \
	"Uncaught exception" "getBackend" "object-cache" "Unable to resolve"; do
	printf "  %-30s %s\n" "$pat" "$(grep -c "$pat" $LOG 2>/dev/null | head -1)"
done
say "  deps discovered late:"
grep -oE "dependency optimized: [^\"]*" $LOG 2>/dev/null | sort -u | sed 's/^/    /' || say "    none"
printf "  log size: %s bytes\n" "$(stat -c %s $LOG 2>/dev/null || echo 0)"

say "--- health verdict ---"
VERDICT=healthy
if [ "$BYPASS_STATUS" != "200" ]; then
	say "  dev-bypass returned $BYPASS_STATUS, not 200. Setup did not complete."
	VERDICT=broken
fi
if [ "${MIN_BYTES:-0}" -lt "$EMPTY_THRESHOLD" ]; then
	say "  Smallest content page is ${MIN_BYTES} bytes, under the ${EMPTY_THRESHOLD} byte floor."
	say "  Pages are empty shells, so content never loaded."
	VERDICT=broken
fi
if [ "$VERDICT" = broken ]; then
	say ""
	say "  BROKEN — do NOT compare the timings above with a healthy setup."
	say "  An empty site renders in a fraction of the time and reads as a speedup."
else
	say "  Content pages populated (smallest ${MIN_BYTES} bytes) and setup completed."
	say "  Timings above are comparable with other healthy setups."
fi

timeout 30 npx astro dev stop >/dev/null 2>&1
say ""
