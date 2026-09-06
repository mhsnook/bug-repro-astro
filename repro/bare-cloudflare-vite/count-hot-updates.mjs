#!/usr/bin/env node
// Counts how many times Vite runs a plugin's hotUpdate hook while nothing is
// edited, on a bare vite + @cloudflare/vite-plugin app. The only thing driving
// them is miniflare writing its own state inside the Vite root on each request.
//
// Reports per platform so the file watcher can be compared: inotify,
// ReadDirectoryChangesW and FSEvents do not agree about sqlite WAL writes.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readdirSync, statSync, writeFileSync } from "node:fs";
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

const server = spawn(process.execPath, [viteBin, `--port=${PORT}`, "--host=127.0.0.1"], {
	cwd: projectRoot,
	env: { ...process.env, NO_COLOR: "1" },
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
for (let i = 0; i < REQUESTS; i++) {
	requests.push(await get(`http://127.0.0.1:${PORT}/`));
	await sleep(1_000);
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
	timings: requests.map((r) => r.ms),
	allRequestsOk: requests.every((r) => r.status === 200),
};

console.log(`### ${LABEL}`);
console.log(`requests            ${result.requests}, all 200: ${result.allRequestsOk}`);
console.log(`timings             ${result.timings.map((m) => `${m}ms`).join(", ")}`);
console.log(`hotUpdate hooks     ${during} during requests (${result.hotUpdatesPerRequest}/request)`);
console.log(`  by environment    ${JSON.stringify(result.perEnvironment)} (requests only)`);
console.log(`files in .wrangler  ${result.wranglerFiles}`);
console.log(
	during === 0
		? "VERDICT: this platform's watcher does not report miniflare's writes."
		: "VERDICT: every request runs every plugin's hotUpdate hook, with nothing edited.",
);

if (OUT) writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
	const { appendFileSync } = await import("node:fs");
	appendFileSync(
		process.env.GITHUB_STEP_SUMMARY,
		`| ${LABEL} | ${result.hotUpdatesPerRequest} | ${during} | ${result.wranglerFiles} | ${result.timings.map((m) => `${m}ms`).join(" ")} |\n`,
	);
}

server.kill("SIGKILL");
process.exit(0);
