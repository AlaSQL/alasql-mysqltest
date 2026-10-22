/**
 * Groups the statements of a --debug run that did not pass by kind, the largest first, with examples.
 *
 *   bun run runner/triage.js [results/debug.jsonl] [--examples=3] [--status=fail|unread|skipped] [--json]
 */
import fs from "fs";

const args = Bun.argv.slice(2);
const file = args.find(a => !a.startsWith("--")) || "results/debug.jsonl";
const examples = Number((args.find(a => a.startsWith("--examples=")) || "--examples=3").split("=")[1]);
const status = (args.find(a => a.startsWith("--status=")) || "").split("=")[1];
const asJson = args.includes("--json");

const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(c => !status || c.status === status);

// the kind: the status and the reason without values, names and the SQL that AlaSQL echoes in a parse error
const kindOf = c =>
	c.status +
	": " +
	c.why
		.replace(/(Parse error) on line \d+:.*/, "$1")
		.replace(/(expected an error) \(.*\)/, "$1")
		.replace(/(row \d+ differs|rows differ \(in any order\)): .*/, "$1")
		.replace(/'(?:[^']|'')*'|"[^"]*"/g, "…")
		.replace(/-?\b\d+(\.\d+)?\b/g, "N")
		.slice(0, 110);

const groups = new Map();
for (const c of rows) {
	const k = kindOf(c);
	if (!groups.has(k)) groups.set(k, { count: 0, files: new Set(), examples: [] });
	const g = groups.get(k);
	g.count++;
	g.files.add(c.file);
	if (g.examples.length < examples) g.examples.push(c);
}
const sorted = [...groups].sort((a, b) => b[1].count - a[1].count);

if (asJson) {
	console.log(JSON.stringify(sorted.map(([kind, g]) => ({ kind, count: g.count, files: g.files.size, examples: g.examples })), null, 2));
	process.exit(0);
}
console.log(`${rows.length} statements that did not pass in ${file}, ${groups.size} kinds\n`);
for (const [kind, g] of sorted) {
	console.log(`${String(g.count).padStart(6)}  ${kind}  (${g.files.size} files)`);
	for (const c of g.examples) console.log(`          ${c.file}:${c.line}\n            ${c.sql.replace(/\s+/g, " ").slice(0, 200)}\n            ${c.why.replace(/\s+/g, " ").slice(0, 160)}`);
}
