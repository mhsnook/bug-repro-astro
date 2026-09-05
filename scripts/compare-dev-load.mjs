#!/usr/bin/env node
// Joins the per-platform measure-dev-load.mjs results into one comparison table.
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? "results");
const runs = readdirSync(dir)
	.filter((f) => f.endsWith(".json"))
	.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
	.sort((a, b) => a.label.localeCompare(b.label));

if (runs.length === 0) {
	console.log("No results to compare.");
	process.exit(0);
}

const seconds = (ms) => `${(ms / 1000).toFixed(2)}s`;
const paths = [...new Set(runs.flatMap((r) => r.routes.map((x) => x.path)))];
const cell = (run, path) => {
	const route = run.routes.find((x) => x.path === path);
	return route ? seconds(route.medianMs) : "—";
};

const md = [
	"## Dev server load times by platform",
	"",
	`Median of ${runs[0].repeats} requests per route, Astro dev server on workerd.`,
	"",
	`| route | ${runs.map((r) => r.label).join(" | ")} |`,
	`| --- | ${runs.map(() => "---").join(" | ")} |`,
	...paths.map((p) => `| \`${p}\` | ${runs.map((r) => cell(r, p)).join(" | ")} |`),
	"",
	"| platform | verdict | cold start | workerd |",
	"| --- | --- | --- | --- |",
	...runs.map(
		(r) =>
			`| ${r.label} | ${r.verdict} | ${
				r.startup.coldStartCrashed ? `crashed, ready on attempt ${r.startup.attemptsUsed}` : "ok"
			} | ${r.workerd ?? "unknown"} |`,
	),
].join("\n");

console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) {
	appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n\n`);
}
