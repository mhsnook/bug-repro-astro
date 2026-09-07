#!/usr/bin/env node
// Counts how many times Vite runs a plugin's hotUpdate hook while nothing is
// edited, on a bare vite + @cloudflare/vite-plugin app. The only thing driving
// them is miniflare writing its own state inside the Vite root on each request.
//
// Reports per platform so the file watcher can be compared: inotify,
// ReadDirectoryChangesW and FSEvents do not agree about sqlite WAL writes.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = dirname(fileURLToPath(import.meta.url));
const viteBin = join(dirname(require.resolve("vite/package.json")), "bin", "vite.js");

const args = Object.fromEntries(
	process.argv
		.slice(2)
		.map((a) => {
			const [k, v = "true"] = a.replace(/^--/, "").split("=");
			return [k, v];
		})
		.filter(([, v]) => v !== ""),
);

const PORT = Number(args.port ?? 4700);
const REQUESTS = Number(args.requests ?? 6);
const LABEL = args.label ?? `${(process.env.RUNNER_OS ?? process.platform).toLowerCase()}`;
// "fsevents" is chokidar's own choice: on macOS it loads the optional fsevents
// native module, everywhere else it falls back to fs.watch. "poll" forces the
// fallback on macOS too, which is the only way to compare the two backends
// against the same writes.
const WATCHER = args.watcher ?? "default";
const OUT = args.out ? resolve(args.out) : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function countWranglerFiles(dir = join(projectRoot, ".wrangler")) {
	let n = 0;
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) n += countWranglerFiles(full);
			else if (statSync(full).isFile()) n++;
		}
	} catch {}
	return n;
}

// Size and mtime of every file under the persist directory. Counting files only
// says they exist; comparing two of these says whether requests write to them,
// which is the question the hook count cannot answer on a platform whose
// watcher stays silent.
function snapshotWrangler(dir = join(projectRoot, ".wrangler"), into = new Map()) {
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) snapshotWrangler(full, into);
			else {
				const st = statSync(full);
				if (st.isFile()) into.set(full, `${st.size}:${st.mtimeMs}`);
			}
		}
	} catch {}
	return into;
}

const diffSnapshots = (before, after) => {
	let changed = 0;
	let added = 0;
	for (const [path, sig] of after) {
		if (!before.has(path)) added++;
		else if (before.get(path) !== sig) changed++;
	}
	return { changed, added, removed: [...before.keys()].filter((k) => !after.has(k)).length };
};

const server = spawn(process.execPath, [viteBin, `--port=${PORT}`, "--host=127.0.0.1"], {
	cwd: projectRoot,
	env: { ...process.env, NO_COLOR: "1", REPRO_WATCHER: WATCHER },
	stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
const collect = (d) => {
	output += d;
};
server.stdout.on("data", collect);
server.stderr.on("data", collect);

const hotUpdateCount = () => (output.match(/hotUpdate #\d+ in env "([^"]+)"/g) ?? []).length;
// Counted from a mark so startup's hooks stay out of the per-request figure.
const perEnvironmentSince = (mark) => {
	const counts = {};
	for (const m of output.slice(mark).matchAll(/hotUpdate #\d+ in env "([^"]+)"/g)) {
		counts[m[1]] = (counts[m[1]] ?? 0) + 1;
	}
	return counts;
};

async function get(url) {
	const started = performance.now();
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
		await res.arrayBuffer();
		return { ms: Math.round(performance.now() - started), status: res.status };
	} catch (err) {
		return { ms: Math.round(performance.now() - started), status: null, error: String(err) };
	}
}

let ready = false;
for (let i = 0; i < 90 && !ready; i++) {
	const probe = await get(`http://127.0.0.1:${PORT}/`);
	if (probe.status !== null) ready = true;
	else await sleep(1_000);
}

if (!ready) {
	console.error("Dev server never became ready. Output follows:");
	console.error(output.split("\n").slice(-30).join("\n"));
	server.kill("SIGKILL");
	process.exit(1);
}

// Only count what the requests below cause, not what starting up caused.
await sleep(2_000);
const baseline = hotUpdateCount();
const outputMark = output.length;
const requests = [];
// Snapshotted around each request rather than around the batch: repeated writes
// to one file are what happens here, and a single before/after pair would count
// that once no matter how many requests caused it.
let writes = { changed: 0, added: 0, removed: 0 };
let before = snapshotWrangler();
for (let i = 0; i < REQUESTS; i++) {
	requests.push(await get(`http://127.0.0.1:${PORT}/`));
	await sleep(1_000);
	const after = snapshotWrangler();
	const d = diffSnapshots(before, after);
	writes = {
		changed: writes.changed + d.changed,
		added: writes.added + d.added,
		removed: writes.removed + d.removed,
	};
	before = after;
}
await sleep(2_000);

const during = hotUpdateCount() - baseline;
const result = {
	label: LABEL,
	platform: process.platform,
	runnerOs: process.env.RUNNER_OS ?? null,
	node: process.version,
	requests: requests.length,
	hotUpdatesDuringRequests: during,
	hotUpdatesPerRequest: Number((during / requests.length).toFixed(2)),
	hotUpdatesAtStartup: baseline,
	perEnvironment: perEnvironmentSince(outputMark),
	wranglerFiles: countWranglerFiles(),
	watcher: WATCHER,
	filesWrittenDuringRequests: writes.changed + writes.added,
	fileWritesPerRequest: Number(((writes.changed + writes.added) / REQUESTS).toFixed(2)),
	fileWrites: writes,
	timings: requests.map((r) => r.ms),
	allRequestsOk: requests.every((r) => r.status === 200),
};

console.log(`### ${LABEL}`);
console.log(`requests            ${result.requests}, all 200: ${result.allRequestsOk}`);
console.log(`timings             ${result.timings.map((m) => `${m}ms`).join(", ")}`);
console.log(`hotUpdate hooks     ${during} during requests (${result.hotUpdatesPerRequest}/request)`);
console.log(`  by environment    ${JSON.stringify(result.perEnvironment)} (requests only)`);
console.log(`files in .wrangler  ${result.wranglerFiles}`);
console.log(`file writes seen     ${result.filesWrittenDuringRequests} (${result.fileWritesPerRequest}/request)`);
console.log(`watcher             ${WATCHER}`);
// Two independent signals. The writes are read straight off the filesystem, so
// they hold whatever the watcher does or does not report.
console.log(
	result.filesWrittenDuringRequests === 0
		? during === 0
			? "VERDICT: nothing was written during the requests, so there was nothing for the watcher to report."
			: "VERDICT: hooks ran without any write under .wrangler, so something else is driving them."
		: during === 0
			? `VERDICT: ${result.filesWrittenDuringRequests} writes happened and the watcher reported none of them.`
			: "VERDICT: every request writes, and every write runs every plugin's hotUpdate hook.",
);

if (OUT) {
	// Runnable on its own, not only through plan.mjs, which is what makes the
	// two backends comparable by hand on a Mac.
	mkdirSync(dirname(OUT), { recursive: true });
	writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
	const { appendFileSync } = await import("node:fs");
	appendFileSync(
		process.env.GITHUB_STEP_SUMMARY,
		`| ${LABEL} | ${WATCHER} | ${result.hotUpdatesPerRequest} | ${during} | ${result.filesWrittenDuringRequests} | ${result.timings.map((m) => `${m}ms`).join(" ")} |\n`,
	);
}

server.kill("SIGKILL");
process.exit(0);
