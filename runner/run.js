/**
 * Runs the MySQL tests (mysql-test/t of the MySQL server) against AlaSQL with a pool of persistent workers and
 * prints a Markdown report to stdout, one section per test file as it finishes (yarn test writes it to
 * results/output.md).
 *
 * Each SQL statement is one check: its result must be what MySQL printed in r/<name>.result (the same
 * rows, the same error or no error).
 *
 *   --only-run=mysql/t/case.test[,...]    exactly these files
 *   --include=REGEX  --exclude=REGEX      filter the test files by name
 *   --concurrency=N                       workers (default: half the cores)
 *   --workerMB=1024                       a worker whose heap grows past this after a file is replaced
 *   --maxMB=<a quarter of the memory>     when the process uses more, the statement running longest is stopped
 *   --timeout=20                          seconds one statement may take; it counts as failed and the file runs again without it
 *   --fileTimeout=120                     seconds one file may take; the rest of a file that takes longer is not run
 *   --debug                               also write every check that is not a pass, as one JSON line, to
 *                                         results/debug.jsonl (replaced on every run)
 *   --printAllErrors                      print every failure, not a sample
 *   --curiousErrorprinting=0.01           share of repeated failures printed besides the first of each kind
 *   --truncSQLStatement=300               cut printed SQL after this many characters
 *
 * ALASQL=path/to/alasql.fs.js tests another build, by default the npm package.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const my = path.join(root, "mysql");
const alasql = require(process.env.ALASQL ? path.resolve(process.env.ALASQL) : "alasql");

const args = Bun.argv.slice(2);
const arg = (name, def) => {
	const i = args.findIndex(a => a === name || a.startsWith(name + "="));
	if (i < 0) return def;
	if (args[i].includes("=")) return args[i].slice(args[i].indexOf("=") + 1);
	const v = args[i + 1];
	return !v || v.startsWith("--") ? true : v;
};
const flag = name => args.includes(name);
const config = {
	onlyRun: arg("--only-run", ""),
	include: arg("--include", ""),
	exclude: arg("--exclude", ""),
	// half the cores: each worker holds the tables of its file, and a few statements build large results
	concurrency: Math.max(1, Number(arg("--concurrency", String(Math.floor((navigator.hardwareConcurrency || 4) / 2))))),
	workerMB: Number(arg("--workerMB", "1024")),
	maxMB: Number(arg("--maxMB", String(Math.round(require("os").totalmem() / 4 / 1048576)))),
	timeout: Number(arg("--timeout", "20")),
	fileTimeout: Number(arg("--fileTimeout", "120")),
	debug: flag("--debug"),
	printAllErrors: flag("--printAllErrors"),
	curious: Number(arg("--curiousErrorprinting", "0.01")),
	trunc: Number(arg("--truncSQLStatement", "300")),
};

if (!fs.existsSync(path.join(my, "t"))) {
	console.error("The MySQL files are missing: run `yarn fetch` first");
	process.exit(1);
}

// ---- what to run ---------------------------------------------------------------------------------------------

const testFile = name => ({ name, file: `mysql/t/${name}.test`, test: path.join(my, "t", name + ".test"), result: path.join(my, "r", name + ".result"), root: my });
// every test of the main suite that has a result file, in name order
let jobs = fs
	.readdirSync(path.join(my, "t"))
	.filter(f => f.endsWith(".test") && fs.existsSync(path.join(my, "r", f.replace(/\.test$/, ".result"))))
	.sort()
	.map(f => testFile(f.replace(/\.test$/, "")));
if (config.onlyRun) {
	if (config.onlyRun === true) {
		console.error("--only-run needs a file: --only-run=mysql/t/case.test");
		process.exit(1);
	}
	jobs = config.onlyRun.split(",").map(f => {
		const p = path.resolve(root, f.trim());
		if (!fs.existsSync(p)) {
			console.error("No such test file: " + p);
			process.exit(1);
		}
		return testFile(path.basename(p, ".test"));
	});
} else {
	if (config.include) jobs = jobs.filter(j => new RegExp(config.include).test(j.name));
	if (config.exclude) jobs = jobs.filter(j => !new RegExp(config.exclude).test(j.name));
}

const debugPath = path.join(root, "results/debug.jsonl");
if (config.debug) {
	fs.mkdirSync(path.dirname(debugPath), { recursive: true });
	fs.writeFileSync(debugPath, "");
}

// ---- report ------------------------------------------------------------------------------------------------

const fmt = n => n.toLocaleString("en-US");
const pct = (a, b) => (b ? Math.floor((100 * a) / b) : 0);
const total = { files: 0, statements: 0, pass: 0, fail: 0, unread: 0, filesClean: 0, crashed: 0, timedOut: 0, notAligned: 0, recycled: 0, memoryStops: 0 };

// One section per file, from what the worker sent: its counts and the failures it chose to print. Nothing of
// a file is kept after its section is printed.
function report(index, job, res) {
	const n = res.counts;
	const ran = n.pass + n.fail + n.unread;
	const out = ["", "---- ---- ---- ---- ---- ---- ----", `### ${index}/${jobs.length} \`${job.file}\` (${res.seconds.toFixed(1)} s)`, ""];
	if (res.crashed) out.push("Runner error: " + res.crashed, "");
	for (const t of res.stopped) out.push(t.seq ? `The statement at line ${t.line} was stopped (${t.reason === "timeout" ? `it ran for more than ${config.timeout} s` : t.reason}): it counts as failed${t.rerun ? ", and the file was run again without it" : ", and the rest of the file was not run"}.` : `Stopped at line ${t.line}: ${t.reason}. The rest of the file was not run.`, "");
	if (res.aligned === false && res.lost) out.push(`The result file stops matching the test at \`${res.lost.file}\` line ${res.lost.line} (${res.lost.what}); the rest of the file is not checked.`, "");
	if (res.printed) out.push(res.printed);
	out.push(`#### ${n.fail === 0 && !res.crashed ? "★" : "☓"} Ran ${fmt(ran)} statements`, "");
	if (n.fail) out.push(`* ${fmt(n.fail)} failed`);
	if (n.unread) out.push(`* ${fmt(n.unread)} not checked (expected output the runner does not read)`);
	out.push(`* ${pct(n.pass, n.pass + n.fail)}% of the checked statements were OK`, "");
	console.log(out.join("\n"));
	total.files++;
	total.statements += ran;
	for (const k of ["pass", "fail", "unread"]) total[k] += n[k];
	if (res.aligned === false) total.notAligned++;
	if (res.crashed) total.crashed++;
	if (res.stopped.some(t => t.reason === "timeout")) total.timedOut++;
	total.memoryStops += res.stopped.filter(t => /MB$/.test(t.reason)).length;
	if (n.fail === 0 && n.pass && !res.crashed) total.filesClean++;
}

// ---- workers -------------------------------------------------------------------------------------------------

const started = performance.now();
console.log("# MySQL test results for AlaSQL\n");
console.log("`" + new Date().toISOString() + " target: alasql@" + alasql.version + "`\n");
const source = fs.existsSync(path.join(my, "SOURCE")) ? fs.readFileSync(path.join(my, "SOURCE"), "utf8").trim() : "";
console.log(`MySQL tests (mysql-test/t${source ? ", " + source : ""}): ${jobs.length} test files, each in a fresh database \`test\`, ${config.concurrency} workers.\n`);

const newWorker = () => new Worker(new URL("./worker.js", import.meta.url).href, { type: "module" });
const options = { debug: config.debug, debugPath, printAllErrors: config.printAllErrors, curious: config.curious, trunc: config.trunc, timeout: config.timeout };

// One file in a worker, with a watchdog: a statement that runs longer than --timeout, or a file longer than
// --fileTimeout, stops the worker. The worker sends a heartbeat before each statement (its number, line and the
// counts so far) and its counts and printed failures when the file is done.
// the running files, for the memory watch: when the process uses more than --maxMB, the statement that has run
// the longest is stopped like a statement that runs too long
const running = new Set();
setInterval(() => {
	if (!running.size || process.memoryUsage.rss() < config.maxMB * 1048576) return;
	let oldest = null;
	for (const r of running) if (!oldest || r.since < oldest.since) oldest = r;
	oldest.kill(`the process used more than ${fmt(config.maxMB)} MB`);
}, 250).unref();

function runJob(w, job) {
	return new Promise(resolve => {
		let beat = { s: 0, l: 0, c: [0, 0, 0] };
		const me = { since: performance.now(), kill: reason => finish({ dead: true, timedOut: { line: beat.l, seq: beat.s, reason } }) };
		running.add(me);
		let timer = null;
		const fileTimer = setTimeout(() => finish({ dead: true, fileLimit: true, timedOut: { line: beat.l, reason: `the file ran for more than ${config.fileTimeout} s` } }), config.fileTimeout * 1000);
		const finish = res => {
			if (!running.has(me)) return;
			running.delete(me);
			clearTimeout(timer);
			clearTimeout(fileTimer);
			w.onmessage = null;
			// a stopped worker sends nothing more: its counts are those of the last heartbeat
			if (res.dead) res.counts = { pass: beat.c[0], fail: beat.c[1], unread: beat.c[2] };
			resolve(res);
		};
		const arm = () => {
			clearTimeout(timer);
			timer = setTimeout(() => finish({ dead: true, timedOut: { line: beat.l, seq: beat.s, reason: "timeout" } }), config.timeout * 1000);
		};
		w.onmessage = ev => {
			const m = ev.data;
			if (m.done) finish(m);
			else {
				beat = m;
				me.since = performance.now();
				arm();
			}
		};
		w.onerror = e => finish({ dead: true, timedOut: { line: beat.l, seq: beat.s, reason: "the worker stopped: " + (e.message || "error") } });
		arm();
		w.postMessage({ ...job, options });
	});
}

const queue = jobs.map((j, i) => ({ ...j, index: i + 1 }));
let done = 0;
await Promise.all(
	Array.from({ length: Math.min(config.concurrency, Math.max(1, jobs.length)) }, async () => {
		let w = newWorker();
		while (queue.length) {
			const job = queue.shift();
			// A statement that runs longer than --timeout blocks the worker: replace the worker and run the file again
			// without that statement (up to 5 times per file); the new run counts that statement as failed and does
			// not count the ones before it again. After --fileTimeout the rest of the file is not run.
			const t0 = performance.now();
			const counts = { pass: 0, fail: 0, unread: 0 };
			const printed = [];
			const stopped = [];
			let attempt = job;
			let res;
			for (;;) {
				res = await runJob(w, attempt);
				for (const k in counts) counts[k] += res.counts[k];
				if (res.printed) printed.push(res.printed);
				if (!res.dead) break;
				w.terminate();
				w = newWorker();
				const t = res.timedOut;
				stopped.push(t);
				if (res.fileLimit) break;
				if (!t.seq || stopped.length >= 5) {
					counts.fail++;
					break;
				}
				t.rerun = true;
				attempt = { ...job, skip: stopped.map(x => x.seq), quietUntil: t.seq, stopReason: t.reason === "timeout" ? `ran for more than ${config.timeout} s` : t.reason };
			}
			done++;
			report(done, job, { ...res, counts, printed: printed.join("\n"), stopped, seconds: (performance.now() - t0) / 1000 });
			// a worker that holds on to memory is replaced
			if (!res.dead && res.heapMB > config.workerMB) {
				w.terminate();
				w = newWorker();
				total.recycled++;
			}
		}
		w.terminate();
	}),
);

const checked = total.pass + total.fail;
console.log("\n-----------------------------\n");
console.log("## Final result\n");
console.log(`* \`alasql@${alasql.version}\` (Bun ${Bun.version})`);
console.log(`* Test files: ${fmt(total.files)}, ${fmt(total.filesClean)} without a failure${total.timedOut ? `, ${fmt(total.timedOut)} with a statement over the ${config.timeout} s timeout` : ""}${total.crashed ? `, ${fmt(total.crashed)} stopped by a runner error` : ""}`);
console.log(`* Statements: ${fmt(total.statements)}: ${fmt(total.pass)} passed, ${fmt(total.fail)} failed, ${fmt(total.unread)} not checked`);
console.log(`* Result files that stop matching the test part way: ${fmt(total.notAligned)} (the rest of those files is not checked)`);
console.log(`* Workers replaced after growing past ${fmt(config.workerMB)} MB: ${fmt(total.recycled)}; statements stopped at ${fmt(config.maxMB)} MB for the process: ${fmt(total.memoryStops)}`);
console.log(`* Final score: ${pct(total.pass, checked)} % of the checked statements were OK\n`);
console.log(`Total script time: ${((performance.now() - started) / 1000).toFixed(1)}s\n`);
console.log("_Repeated failures are sampled; run with --printAllErrors to see every one, or --debug for results/debug.jsonl_");

// a worker stopped in the middle of a statement may keep its thread busy; the report is complete, so end here
process.exit(0);
