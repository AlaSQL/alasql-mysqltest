/**
 * Runs MySQL test files, one per job, against its own AlaSQL instance (the worker is reused for many files).
 * Each file starts in a fresh database `test`, as mysqltest does.
 *
 * The worker interprets the mysqltest language as mysqltest would (variables, --source, if, while, --echo, ...)
 * and reads the expected result file (mysql-test/r/<name>.result) along with it: each statement is echoed there,
 * followed by its result set, its error or nothing. Every statement goes to AlaSQL as written; the values of
 * variables that come from a query (`let $v = `SELECT ...``) are AlaSQL's answers.
 *
 * Messages to the main thread: {start, line} before each statement (for the timeout), {check} after it, {done}.
 */
import fs from "fs";
import path from "path";
import { parseTest } from "./mysqltest.js";
import { check } from "./compare.js";
import { heapStats } from "bun:jsc";

const alasql = require(process.env.ALASQL ? path.resolve(process.env.ALASQL) : "alasql");
alasql.options.modifier = "RECORDSET"; // the column list, also for columns that are NULL in every row

const message = e => String(e && e.message !== undefined ? e.message : e).replace(/\s+/g, " ").trim() || "no error message";

// Parsed files: the included ones (shared by many tests) are kept for the whole run; a test file, and a test
// file another one sources, only while its test runs
const parsedIncludes = new Map();
let parsedForTest = new Map();
const parseFile = file => {
	if (!file) return null;
	const cache = file.includes(`${path.sep}include${path.sep}`) ? parsedIncludes : parsedForTest;
	if (!cache.has(file)) cache.set(file, parseOne(file));
	return cache.get(file);
};
function parseOne(file) {
	const items = fs.existsSync(file) ? parseTest(fs.readFileSync(file, "utf8")) : null;
	// each item knows its file (for reports about included files)
	const mark = list => list && list.forEach(it => ((it.file = path.basename(file)), it.kind === "block" && (mark(it.body), it.elseBody && mark(it.elseBody))));
	mark(items);
	return items;
}

// what a report prints: the first failure of each kind this worker sees, and a share of the rest
const trunc = (s, n) => (n > 1 && s.length > n ? s.slice(0, n - 1) + "…" : s);
const oneLine = s => s.replace(/\s+/g, " ").trim();
const kindOf = c =>
	c.why
		.replace(/Parse error[\s\S]*/, "Parse error")
		.replace(/(rows? (?:\d+ )?differs?|expected \d+ (?:rows|columns), got)[\s\S]*/, "$1")
		.replace(/\(In [\s\S]*$/, "") // the code of a missing function
		.replace(/\[[^\]]*\]/g, "[]") // alasql.fn["name"]
		.replace(/\((?:[^()]|\([^()]*\))*\)/g, "()") // expected an error (message)
		.replace(/^((?:[^:]*:){2})[\s\S]*$/, "$1") // names and values after "error: Table does not exist:"
		.replace(/'[^']*'|"[^"]*"/g, "")
		.replace(/[^a-z]/gi, "")
		.slice(0, 60);
const seenKinds = new Set();
let failuresSeen = 0;

// ---- AlaSQL state --------------------------------------------------------------------------------------------

function resetAll() {
	alasql.useid = "alasql";
	for (const id of Object.keys(alasql.databases)) if (id !== "alasql" && id !== "dbo") delete alasql.databases[id];
	const db = alasql.databases.alasql;
	db.tables = {};
	db.views = {};
	db.triggers = {};
	db.indices = {};
	db.sqlCache = {};
	db.astCache = {};
	alasql.tables = db.tables;
	alasql.sets = {};
	alasql.vars = {};
	alasql("CREATE DATABASE test");
	alasql("USE test");
}

// One statement as AlaSQL sees it: {error} | {columns, rows} | {count}
function exec(sql) {
	try {
		const res = alasql(sql);
		if (res && Array.isArray(res.data) && Array.isArray(res.columns)) {
			let cols = res.columns.map(c => c.columnid);
			if (!cols.length && res.data.length) cols = Object.keys(res.data[0]);
			return { columns: cols, rows: res.data.map(r => (Array.isArray(r) ? r : cols.map(c => r[c]))) };
		}
		if (Array.isArray(res)) return { columns: res.length ? Object.keys(res[0]) : [], rows: res.map(r => Object.values(r)) };
		return { count: typeof res === "number" ? res : null };
	} catch (e) {
		return { error: message(e) };
	}
}

// ---- the expected result file --------------------------------------------------------------------------------

const norm = l => l.replace(/^\s+/, "").replace(/\s+$/, "");
const isWarningLine = l => /^(Warning|Note|Error)\t\d+\t/.test(l);
const isInfoLine = l => /^(affected rows: \d+|info: |Warnings:$)/.test(l);

// The output of one statement: a result set (header and rows, tab-separated), an error, or nothing
function readOutput(lines) {
	const kept = [];
	for (let k = 0; k < lines.length; k++) {
		const l = lines[k];
		if (l === "Warnings:") {
			while (k + 1 < lines.length && isWarningLine(lines[k + 1])) k++;
			continue;
		}
		if (isInfoLine(l)) continue;
		kept.push(l);
	}
	if (!kept.length) return { kind: "none" };
	const err = /^ERROR (\w{5}): ([\s\S]*)$/.exec(kept[0]) || /^(Got one of the listed errors)$/.exec(kept[0]);
	if (err) return kept.length === 1 ? { kind: "error", message: err[2] || err[1] } : { kind: "unread", why: "an error followed by more output" };
	const columns = kept[0].split("\t");
	const rows = kept.slice(1).map(l => l.split("\t"));
	if (rows.some(r => r.length !== columns.length)) return { kind: "unread", why: "rows the runner cannot cut into columns (a value with a tab or a new line)" };
	return { kind: "rows", columns, rows };
}

// ---- variables -----------------------------------------------------------------------------------------------

// A variable is {value, sure}. A value is sure when it comes from the test itself; a value AlaSQL computed (let
// from a query) or one that mysql-test-run would set (a path, a plugin name) is not, and matches anything when
// the runner looks for an echo in the result file.
const VAR = /\$(\w+)/g;
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function substitute(text, vars) {
	return text
		.replace(/\\\$/g, "\u0000")
		.replace(VAR, (m, name) => (name in vars ? vars[name].value : ""))
		.replace(/\u0000/g, "$");
}
const allSure = (text, vars) => [...text.matchAll(VAR)].every(m => m[1] in vars && vars[m[1]].sure);

// the echo of a statement as one pattern per line, without leading white space. A blank line may or may not be
// echoed (it is when a variable's value brings it), and a line that is only an unknown variable may stand for
// several lines. With vars, the variables are put in (sure ones as written, others match anything).
function statementPatterns(text, vars) {
	const marked = vars ? text.replace(/\\\$/g, "\u0000").replace(VAR, (m, name) => (name in vars && vars[name].sure ? vars[name].value : "\u0001")).replace(/\u0000/g, "$") : text;
	const pats = [];
	for (const l of marked.split("\n").map(norm)) {
		if (l === "") pats.push({ re: /^$/, optional: true });
		else if (l === "\u0001") pats.push({ re: /[\s\S]*/, many: true });
		else pats.push({ re: new RegExp("^" + escapeRe(l).replace(/\u0001/g, "[\\s\\S]*") + "$") });
	}
	// leading and trailing blank lines are never echoed
	while (pats.length && pats[0].optional) pats.shift();
	while (pats.length && pats[pats.length - 1].optional) pats.pop();
	return pats;
}
// the line an --echo prints
function echoPattern(text, vars) {
	const marked = text.replace(/\\\$/g, "\u0000").replace(VAR, (m, name) => (name in vars && vars[name].sure ? vars[name].value : "\u0001")).replace(/\u0000/g, "$");
	return [{ re: new RegExp("^" + escapeRe(norm(marked)).replace(/\u0001/g, "[\\s\\S]*") + "$") }];
}

// the first word of a statement, for an echo that --replace_* may have changed
const looseFirstLine = text => {
	const word = norm(text).split(/\s/)[0];
	return [{ re: new RegExp("^" + escapeRe(word) + "(\\s|$)", "i") }];
};

const firstValue = r => (r.rows && r.rows.length && r.rows[0].length ? textOf(r.rows[0][0]) : "");
const textOf = v => (v === null || v === undefined ? "NULL" : v === true ? "1" : v === false ? "0" : typeof v === "object" ? JSON.stringify(v) : String(v));

// the value of a let: text, $var, `query` or query_get_value(query, column, row)
function letValue(expr, vars) {
	const e = expr.trim();
	const bt = /^`([\s\S]*)`$/.exec(e);
	if (bt) return { value: firstValue(exec(substitute(bt[1], vars))), sure: false };
	const qgv = /^query_get_value\s*\(([\s\S]*),\s*([^,]+?)\s*,\s*(\d+)\s*\)$/i.exec(e);
	if (qgv) {
		const r = exec(substitute(qgv[1], vars));
		const col = substitute(qgv[2], vars).trim();
		const k = r.columns ? r.columns.findIndex(c => String(c).toLowerCase() === col.toLowerCase()) : -1;
		const row = r.rows && r.rows[Number(qgv[3]) - 1];
		return { value: row && k >= 0 ? textOf(row[k]) : "No such row", sure: false };
	}
	const text = expr.replace(/^\s+/, ""); // trailing spaces are kept, as mysqltest does
	return { value: substitute(text, vars), sure: allSure(text, vars) };
}
// the same for the lookahead, without running anything
const letGuess = (expr, vars) => (/^\s*(`|query_get_value)/i.test(expr) ? { value: "", sure: false } : { value: substitute(expr.replace(/^\s+/, ""), vars), sure: allSure(expr, vars) });

function condition(cond, vars) {
	let c = cond.trim();
	const bt = /^(!?)\s*`([\s\S]*)`$/.exec(c);
	if (bt) {
		const v = firstValue(exec(substitute(bt[2], vars)));
		const truthy = v !== "" && v !== "0" && v !== "NULL";
		return bt[1] ? !truthy : truthy;
	}
	c = substitute(c, vars);
	const cmp = /^(.*?)\s*(==|!=|<=|>=|<|>)\s*(.*)$/.exec(c);
	if (cmp) {
		const a = cmp[1].trim().replace(/^(['"])(.*)\1$/, "$2");
		const b = cmp[3].trim().replace(/^(['"])(.*)\1$/, "$2");
		const num = x => (x !== "" && !isNaN(Number(x)) ? Number(x) : x);
		const [x, y] = [num(a), num(b)];
		switch (cmp[2]) {
			case "==": return a === b;
			case "!=": return a !== b;
			case "<": return x < y;
			case ">": return x > y;
			case "<=": return x <= y;
			case ">=": return x >= y;
		}
	}
	const neg = c.startsWith("!");
	const v = (neg ? c.slice(1) : c).trim().replace(/^(['"])(.*)\1$/, "$2");
	const truthy = v !== "" && v !== "0";
	return neg ? !truthy : truthy;
}

// ---- one test file -------------------------------------------------------------------------------------------

// commands whose output (if any) the runner does not read; the next echo is searched for after them
const PRINTS = new Set(["exec", "execw", "system", "cat_file", "list_files", "diff_files", "query_vertical", "reap", "perl", "send", "send_eval", "query_horizontal", "file_exists", "exec_in_background", "shutdown_server", "send_shutdown", "change_user", "connect", "connection", "disconnect", "secret"]);
// commands that send a statement: eval puts the variables in, query and send do not
const SQL_COMMANDS = new Set(["query", "eval", "send", "send_eval", "query_vertical", "query_horizontal"]);
const EVALS = new Set(["eval", "send_eval"]);

function runFile(job) {
	const items = parseFile(job.test);
	const out = fs.readFileSync(job.result, "utf8").split("\n");
	if (out[out.length - 1] === "") out.pop();
	const sure = value => ({ value, sure: true });
	const unsure = value => ({ value, sure: false });
	// what mysql-test-run would set: known to the runner, but the real values are not
	const vars = { MYSQL_TEST_DIR: unsure(job.root), MYSQLTEST_VARDIR: unsure(path.join(job.root, "var")), MYSQL_TMP_DIR: unsure(path.join(job.root, "tmp")), DEFAULT_ENGINE: sure("InnoDB"), ENGINE: sure("InnoDB") };
	const state = { queryLog: true, resultLog: true, sorted: false, unreadNext: null, delimiter: ";", skipOk: false };
	let o = 0;
	let aligned = true;
	let lost = null;
	let serial = 0;
	const testName = path.basename(job.test);

	// The worker keeps no checks: it counts them, writes the few it prints (the first of each kind, and a share of
	// the rest), and with --debug appends the ones that did not pass to results/debug.jsonl in small batches
	const counts = { pass: 0, fail: 0, unread: 0 };
	const printed = [];
	let debugLines = [];
	const flushDebug = () => {
		if (debugLines.length) fs.appendFileSync(job.options.debugPath, debugLines.join("\n") + "\n");
		debugLines = [];
	};
	function record(c) {
		counts[c.status]++;
		if (job.options.debug && (c.status !== "pass" || c.ms > 1000)) {
			debugLines.push(JSON.stringify({ file: job.file, ...c }));
			if (debugLines.length >= 200) flushDebug();
		}
		if (c.status !== "fail") return;
		const kind = kindOf(c);
		const curious = job.options.curious > 0 && failuresSeen++ % Math.max(1, Math.round(1 / job.options.curious)) === 0;
		if (job.options.printAllErrors || !seenKinds.has(kind) || curious) {
			seenKinds.add(kind);
			const where = (c.inc ? "`" + c.inc + "` " : "") + "line " + c.line;
			printed.push("```sql\n" + trunc(oneLine(c.sql), job.options.trunc) + "\n\n" + where + " => " + trunc(c.why, job.options.trunc) + "\n```\n");
		}
	}
	const lineAt = k => (k < out.length ? norm(out[k]) : null);
	// the number of result lines the patterns match from line k, or -1
	const matchSeq = (k, pats, x = 0, budget = { n: 2000 }) => {
		if (x === pats.length) return 0;
		if (--budget.n < 0) return -1;
		const p = pats[x];
		if (p.many) {
			for (let m = 1; m <= 400 && lineAt(k + m - 1) !== null; m++) {
				const rest = matchSeq(k + m, pats, x + 1, budget);
				if (rest >= 0) return m + rest;
			}
			return -1;
		}
		const line = lineAt(k);
		if (line !== null && p.re.test(line)) {
			const rest = matchSeq(k + 1, pats, x + 1, budget);
			if (rest >= 0) return 1 + rest;
		}
		return p.optional ? matchSeq(k, pats, x + 1, budget) : -1;
	};
	// a quick test for the lookahead: the first two lines that must be there
	const matchesAt = (k, pats) => {
		const must = pats.filter(p => !p.optional).slice(0, 2);
		if (!must.length) return false;
		if (must[0].many) return true;
		return lineAt(k) !== null && must[0].re.test(lineAt(k)) && (must.length < 2 || must[1].many || (lineAt(k + 1) !== null && (must[1].re.test(lineAt(k + 1)) || pats.indexOf(must[1]) - pats.indexOf(must[0]) > 1)));
	};

	// What a list of items echoes first, without running it: {cands: [patterns], certain} (certain: the list
	// always echoes one of cands before anything else). ctx {qlog, delimiter, vars} is updated as the list goes.
	function firstEchoes(list, from, ctx, depth = 0) {
		const cands = [];
		for (let k = from; k < list.length; k++) {
			const it = list[k];
			if (it.kind === "sql") {
				if (ctx.qlog) {
					cands.push(ctx.replaced ? looseFirstLine(it.sql) : statementPatterns(it.sql + ctx.delimiter, null));
					return { cands, certain: true };
				}
			} else if (it.kind === "cmd") {
				const name = it.name;
				if (name === "disable_query_log") ctx.qlog = false;
				else if (name === "enable_query_log") ctx.qlog = true;
				else if (name === "delimiter") ctx.delimiter = it.args;
				else if (/^replace_|^lowercase_result$/.test(name)) ctx.replaced = true;
				else if (name === "let") {
					const m = /^\s*\$?(\w+)\s*=\s*([\s\S]*)$/.exec(it.args);
					if (m) ctx.vars[m[1]] = letGuess(m[2], ctx.vars);
				} else if (name === "inc" || name === "dec") {
					const v = it.args.trim().replace(/^\$/, "");
					if (ctx.vars[v]) ctx.vars[v] = { value: String(Number(ctx.vars[v].value || 0) + (name === "inc" ? 1 : -1)), sure: ctx.vars[v].sure };
				} else if (name === "echo") {
					cands.push(echoPattern(it.args, ctx.vars));
					return { cands, certain: true };
				} else if (SQL_COMMANDS.has(name) && ctx.qlog && it.args.trim()) {
					cands.push(ctx.replaced ? looseFirstLine(it.args) : statementPatterns(it.args + ctx.delimiter, EVALS.has(name) ? ctx.vars : null));
					return { cands, certain: true };
				} else if (name === "source" && depth < 8) {
					const sub = parseFile(includePath(it.args, ctx.vars));
					if (sub) {
						const r = firstEchoes(sub, 0, ctx, depth + 1);
						cands.push(...r.cands);
						if (r.certain) return { cands, certain: true };
					}
				} else if (name === "exit") return { cands, certain: true };
			} else if (it.kind === "block" && depth < 8) {
				// a block may or may not run: what it echoes first is possible, not certain
				const save = { ...ctx, vars: { ...ctx.vars } };
				cands.push(...firstEchoes(it.body, 0, { ...save, vars: { ...save.vars } }, depth + 1).cands);
				if (it.elseBody) cands.push(...firstEchoes(it.elseBody, 0, { ...save, vars: { ...save.vars } }, depth + 1).cands);
			}
		}
		return { cands, certain: false };
	}

	// the possible next echoed lines after the current item, up the stack of running lists
	function lookahead(stack) {
		const ctx = { qlog: state.queryLog, delimiter: state.delimiter, vars: { ...vars }, replaced: false };
		const cands = [];
		for (let s = stack.length - 1; s >= 0; s--) {
			const f = stack[s];
			const r = firstEchoes(f.items, f.idx, ctx);
			cands.push(...r.cands);
			if (r.certain) return cands;
			// the body of a while loop may run again
			if (f.loop) cands.push(...firstEchoes(f.items, 0, { ...ctx, vars: { ...ctx.vars } }).cands);
		}
		return cands;
	}

	// the output from o up to the next echoed line
	const region = stack => {
		const cands = lookahead(stack);
		let k = o;
		if (cands.length) while (k < out.length && !cands.some(c => matchesAt(k, c))) k++;
		else k = out.length;
		const lines = out.slice(o, k);
		o = k;
		return lines;
	};
	// the echo of a statement or an --echo must be next in the result file; after --replace_* the echo is
	// changed too, so then only its first word is checked
	const expectEcho = (pats, text) => {
		if (state.unreadNext && text && pats.length && lineAt(o) !== null && norm(text).split(/\s/)[0].toLowerCase() === lineAt(o).split(/\s/)[0].toLowerCase()) {
			const m = matchSeq(o, pats);
			o += m >= 0 ? m : pats.filter(p => !p.optional).length;
			state.skipOk = false;
			return true;
		}
		const m = matchSeq(o, pats);
		if (m >= 0) {
			o += m;
			state.skipOk = false;
			return true;
		}
		// after a command whose output the runner does not read (exec, reap, ...), skip that output
		if (state.skipOk)
			for (let k = o + 1; k < Math.min(out.length, o + 5000); k++) {
				const m2 = matchSeq(k, pats);
				if (m2 >= 0) {
					o = k + m2;
					state.skipOk = false;
					return true;
				}
			}
		return false;
	};

	// the file (an included one too) and line where the result file stops matching, with both texts
	const lose = (it, what, wanted) => {
		aligned = false;
		lost = { line: it.line, file: it.file, what, wanted: String(wanted || "").slice(0, 120), found: (out[o] ?? "(end of the result file)").slice(0, 120), at: o + 1 };
	};

	function statement(it, sql, pats, stack) {
		if (state.queryLog && !expectEcho(pats, sql)) return lose(it, "the result file does not echo this statement here", sql.split("\n")[0]);
		// statements are numbered in the order they run; a run again after a timeout leaves out the statements in
		// job.skip and does not report the ones before job.quietUntil again
		const seq = ++serial;
		if (job.skip && job.skip.includes(seq)) {
			region(stack);
			state.unreadNext = null;
			state.sorted = false;
			// the statement that ran too long in an earlier attempt: a failure, not run again
			if (seq === job.skip[job.skip.length - 1]) record({ line: it.line, inc: it.file !== testName ? it.file : undefined, sql, status: "fail", why: "stopped: " + (job.stopReason || "timeout") });
			return;
		}
		// a heartbeat before each statement: the main thread stops a statement that runs too long
		self.postMessage({ s: seq, l: it.line, c: [counts.pass, counts.fail, counts.unread] });
		const quiet = job.quietUntil && seq < job.quietUntil;
		// with the query log and the result log off (setup loops), the statement runs but is not a check
		if (quiet || (!state.queryLog && !state.resultLog)) {
			exec(sql);
			region(stack);
			state.unreadNext = null;
			state.sorted = false;
			return;
		}
		const t0 = performance.now();
		const result = exec(sql);
		const ms = Math.round(performance.now() - t0);
		const lines = region(stack);
		const exp = state.resultLog || /^ERROR /.test(lines[0] || "") ? readOutput(lines) : { kind: "unread", why: "--disable_result_log" };
		let c;
		const base = { line: it.line, sql, ms };
		if (it.file !== testName) base.inc = it.file;
		if (state.unreadNext) c = { ...base, status: "unread", why: state.unreadNext };
		else if (exp.kind === "unread") c = { ...base, status: "unread", why: exp.why };
		else {
			const v = check(exp, result, sql, state.sorted);
			c = { ...base, status: v.ok ? "pass" : "fail", why: v.why || "" };
			// the expected and actual rows only for the debug file, cut short
			if (!v.ok && job.options.debug) {
				c.expected = exp.kind === "rows" ? { columns: exp.columns, rows: exp.rows.slice(0, 10) } : exp;
				c.got = result.error ? { error: result.error } : result.rows ? result.rows.slice(0, 10) : result.count;
			}
		}
		state.unreadNext = null;
		state.sorted = false;
		record(c);
	}

	function command(it, stack) {
		const name = it.name;
		switch (name) {
			case "echo":
				// an empty line after output the runner does not read could be anywhere in that output
				if (state.skipOk && norm(it.args) === "") return;
				if (!expectEcho(echoPattern(it.args, vars))) lose(it, "the result file does not have this --echo here", substitute(it.args, vars));
				return;
			case "let": {
				const m = /^\s*\$?(\w+)\s*=\s*([\s\S]*)$/.exec(it.args);
				if (m) vars[m[1]] = letValue(m[2], vars);
				return;
			}
			case "inc":
			case "dec": {
				const v = it.args.trim().replace(/^\$/, "");
				const old = vars[v] || sure("0");
				vars[v] = { value: String(Number(old.value || 0) + (name === "inc" ? 1 : -1)), sure: old.sure };
				return;
			}
			case "expr": {
				const m = /^\s*\$(\w+)\s*=\s*(.*)$/.exec(it.args);
				if (m) {
					const e = substitute(m[2], vars);
					let value = e;
					try {
						if (/^[\d\s+\-*/%().]+$/.test(e)) value = String(Function("return (" + e + ")")());
					} catch {}
					vars[m[1]] = { value, sure: allSure(m[2], vars) };
				}
				return;
			}
			case "disable_query_log":
				state.queryLog = false;
				return;
			case "enable_query_log":
				state.queryLog = true;
				return;
			case "disable_result_log":
				state.resultLog = false;
				return;
			case "enable_result_log":
				state.resultLog = true;
				return;
			case "sorted_result":
			case "partially_sorted_result":
				state.sorted = true;
				return;
			case "replace_result":
			case "replace_column":
			case "replace_regex":
			case "replace_numeric_round":
			case "lowercase_result":
				state.unreadNext = `--${name} changes the expected output`;
				return;
			case "delimiter":
				state.delimiter = it.args;
				return;
			case "query":
			case "eval":
			case "send_eval":
			case "send":
				if (it.args.trim()) {
					const ev = EVALS.has(name);
					statement(it, ev ? substitute(it.args, vars) : it.args, statementPatterns(it.args + state.delimiter, ev ? vars : null), stack);
				}
				if (name.startsWith("send")) state.skipOk = true;
				return;
			case "query_vertical":
			case "query_horizontal":
				if (state.queryLog && !expectEcho(statementPatterns(it.args + state.delimiter, null))) return lose(it, "the result file does not echo this statement here", it.args);
				exec(it.args);
				state.skipOk = true;
				return;
			case "source": {
				const sub = parseFile(includePath(it.args, vars));
				if (sub) run(sub, stack, false);
				return;
			}
			case "exit":
				throw { exit: true };
			default:
				if (PRINTS.has(name)) state.skipOk = true;
		}
	}

	// does the result file show, next, what this list echoes first?
	const shown = list => {
		const r = firstEchoes(list, 0, { qlog: state.queryLog, delimiter: state.delimiter, vars: { ...vars } });
		return { yes: r.cands.some(c => matchesAt(o, c)), certain: r.certain };
	};

	function run(items, stack, loop) {
		const frame = { items, idx: 0, loop };
		stack.push(frame);
		try {
			for (let at = 0; at < items.length && aligned; at++) {
				const it = items[at];
				frame.idx = at + 1; // the lookahead starts after the current item
				if (it.kind === "sql") statement(it, it.sql, statementPatterns(it.sql + state.delimiter, null), stack);
				else if (it.kind === "cmd") command(it, stack);
				else if (it.kind === "block") block(it, stack);
			}
		} finally {
			stack.pop();
		}
	}

	// if and while follow the result file where the block echoes something: MySQL's answers decided there, not
	// AlaSQL's. A block that echoes nothing follows its condition.
	function block(it, stack) {
		if (it.type === "if") {
			const body = shown(it.body);
			const other = it.elseBody ? shown(it.elseBody) : { yes: false, certain: false };
			const take = body.yes ? true : other.yes ? false : body.certain ? false : other.certain ? true : condition(it.cond, vars);
			const list = take ? it.body : it.elseBody;
			if (list) run(list, stack, false);
			return;
		}
		for (let guard = 0; guard < 5000 && aligned; guard++) {
			const body = shown(it.body);
			const go = body.certain ? body.yes : condition(it.cond, vars);
			if (!go) break;
			run(it.body, stack, true);
		}
	}

	let exited = false;
	try {
		run(items, [], false);
	} catch (e) {
		if (!e || !e.exit) throw e;
		exited = true;
	}
	if (lost && job.options.debug) debugLines.push(JSON.stringify({ file: job.file, status: "misaligned", why: lost.what, ...lost }));
	flushDebug();
	// how far into the result file the run got (a run that ends early leaves lines over)
	return { counts, printed: printed.join("\n"), aligned, lost, resultLines: out.length, resultRead: o, exited };
}

function includePath(arg, vars) {
	const p = substitute(arg.trim().replace(/;$/, ""), vars).trim();
	if (!p || p.includes("$")) return null;
	const full = path.isAbsolute(p) ? p : path.join(root, p);
	return fs.existsSync(full) ? full : null;
}

let root = "";

// ---- messages ------------------------------------------------------------------------------------------------

self.addEventListener("message", ev => {
	const job = ev.data;
	root = job.root;
	resetAll();
	let out;
	try {
		out = runFile(job);
	} catch (e) {
		out = { crashed: message(e), counts: { pass: 0, fail: 0, unread: 0 }, printed: "" };
	}
	// nothing of this file stays: its tables, its parsed text. The heap size tells the main thread when to
	// replace this worker (memory AlaSQL holds on to)
	resetAll();
	parsedForTest = new Map();
	Bun.gc(true);
	self.postMessage({ done: true, file: job.file, ...out, heapMB: Math.round(heapStats().heapSize / 1048576) });
});
