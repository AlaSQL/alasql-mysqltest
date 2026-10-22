/**
 * Compares what AlaSQL did with what MySQL printed for one statement.
 *
 *   check(expected, got, sql, sorted) -> {ok: true} | {ok: false, why}
 *
 * expected: {kind: "none" | "rows" | "error"}; got: {error} or {columns, rows} or {count}.
 * Values are compared as mysqltest prints them: NULL as NULL, booleans as 1 and 0, numbers equal when they are
 * the same number (2.00 is 2), and a float equal when it rounds to the digits MySQL printed. Without ORDER BY
 * (or with --sorted_result) the rows may come in any order.
 */

const pad = n => String(n).padStart(2, "0");

// a JavaScript value as mysqltest prints it
export function myText(v) {
	if (v === null || v === undefined) return "NULL";
	if (v === true) return "1";
	if (v === false) return "0";
	if (typeof v === "number") return Number.isNaN(v) ? "NaN" : String(v);
	if (typeof v === "bigint") return String(v);
	if (v instanceof Date) return isNaN(v) ? "Invalid Date" : `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())} ${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}`;
	if (typeof v === "object") return JSON.stringify(v);
	return String(v);
}

const NUM = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

function same(exp, got) {
	if (exp === got) return true;
	if (NUM.test(exp) && NUM.test(got)) {
		const a = Number(exp);
		const b = Number(got);
		if (a === b) return true;
		// MySQL printed fewer digits (FLOAT, DECIMAL scale): equal when ours rounds to them
		const digits = exp.replace(/[eE].*/, "").replace(/[-+.]/g, "").replace(/^0+/, "").length;
		if (digits > 0 && digits < 17 && Number(b.toPrecision(digits)) === a) return true;
	}
	return false;
}

const show = row => row.map(v => (v === "" ? "''" : v)).join(" | ");

export function check(expected, got, sql, sorted) {
	if (expected.kind === "error") {
		if (got.error) return { ok: true };
		return { ok: false, why: "expected an error (" + expected.message + "), got " + (got.rows ? got.rows.length + " rows" : "success") };
	}
	if (got.error) return { ok: false, why: "error: " + got.error };
	if (expected.kind === "none") return { ok: true };
	if (expected.kind !== "rows") return { ok: false, why: "nothing to compare" };
	if (!got.rows) return { ok: false, why: `expected ${expected.rows.length} rows, got ${got.count !== null && got.count !== undefined ? "the count " + got.count : "no result set"}` };
	const ours = got.rows.map(r => r.map(myText));
	const theirs = expected.rows;
	if (ours.length !== theirs.length) return { ok: false, why: `expected ${theirs.length} rows, got ${ours.length}` };
	const width = expected.columns.length;
	if (ours.length && ours[0].length !== width) return { ok: false, why: `expected ${width} columns, got ${ours[0].length}` };
	if (!ours.length && got.columns && got.columns.length && got.columns.length !== width) return { ok: false, why: `expected ${width} columns, got ${got.columns.length}` };
	const rowsSame = (a, b) => a.length === b.length && a.every((v, i) => same(b[i], v));
	const firstDiff = (a, b) => a.findIndex((r, i) => !rowsSame(r, b[i]));
	const d = firstDiff(ours, theirs);
	if (d < 0) return { ok: true };
	// without ORDER BY (or with --sorted_result) the order of the rows is not part of the result
	if (sorted || !/\bORDER\s+BY\b/i.test(sql)) {
		const key = r => r.map(v => (NUM.test(v) ? String(Number(v)) : v)).join("\u0001");
		const cmp = (x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0);
		const a = [...ours].sort(cmp);
		const b = [...theirs].sort(cmp);
		const d2 = firstDiff(a, b);
		if (d2 < 0) return { ok: true };
		return { ok: false, why: `rows differ (in any order): expected ${show(b[d2])}, got ${show(a[d2])}` };
	}
	return { ok: false, why: `row ${d + 1} differs: expected ${show(theirs[d])}, got ${show(ours[d])}` };
}
