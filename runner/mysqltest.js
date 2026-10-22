/**
 * Reads a MySQL test file (mysql-test/t/<name>.test, or an included .inc) in the mysqltest language: SQL
 * statements and mysqltest commands.
 *
 *   parseTest(text) -> items:
 *     {kind: "sql", sql, line}                     a statement, up to the current delimiter
 *     {kind: "cmd", name, args, line}              a mysqltest command (--echo, let, source, error, ...)
 *     {kind: "block", type: "if"|"while", cond, body: items, elseBody: items|null, line}
 *
 * A command is written "--name args" on one line, or "name args" up to the delimiter. Lines starting with #
 * are comments. write_file, append_file and perl take the lines up to their end marker (EOF by default).
 */

// the mysqltest commands (a line that starts with one of these, without --, is a command, not SQL)
export const COMMANDS = new Set(
	`append_file assert cat_file change_user character_set chmod connect connection copy_file copy_files_wildcard dec delimiter die diff_files dirty_close disable_abort_on_error disable_async_client disable_connect_log disable_info disable_metadata disable_ps_protocol disable_query_log disable_reconnect disable_result_log disable_rpl_parse disable_session_track_info disable_testcase disable_warnings disconnect echo enable_abort_on_error enable_async_client enable_connect_log enable_info enable_metadata enable_ps_protocol enable_query_log enable_reconnect enable_result_log enable_rpl_parse enable_session_track_info enable_testcase enable_warnings end end_timer error eval exec exec_in_background execw exit expr file_exists force-cpdir force-rmdir horizontal_results if inc let list_files list_files_append_file list_files_write_file lowercase_result mkdir move_file output partially_sorted_result perl ping query query_attributes query_get_value query_horizontal query_vertical real_sleep reap remove_file remove_files_wildcard replace_column replace_numeric_round replace_regex replace_result require reset_connection result_format rmdir save_master_pos secret send send_eval send_quit send_shutdown shutdown_server skip skip_if_hypergraph sleep sorted_result source start_timer sync_slave_with_master sync_with_master system vertical_results wait_for_slave_to_stop while write_file`.split(
		/\s+/,
	),
);

export function parseTest(text) {
	const lines = text.split("\n");
	let delimiter = ";";
	let i = 0;
	let sawElse = false; // the last block body ended with "} else {"

	// one level of items, up to a "}" (the end of a block) or the end of the file
	function readItems(inBlock) {
		const items = [];
		let buf = [];
		let bufLine = 0;
		while (i < lines.length) {
			const raw = lines[i];
			const lineNo = i + 1;
			const t = raw.trim();
			i++;
			if (!buf.length) {
				if (t === "" || t.startsWith("#")) continue;
				if (t === "}" || t.startsWith("}")) {
					// "} else {" ends the if body and starts the else body
					if (/^\}\s*else\b/.test(t)) {
						sawElse = true;
						if (!/\{\s*$/.test(t)) {
							while (i < lines.length && lines[i].trim() === "") i++;
							if (i < lines.length && lines[i].trim() === "{") i++;
						}
					}
					if (inBlock) return items;
					continue;
				}
				// --command args (one line, no delimiter)
				if (t.startsWith("--")) {
					const m = /^--\s*([\w-]+)\s*(.*)$/.exec(t);
					if (!m) continue; // "--" alone or a comment
					const name = m[1].toLowerCase();
					if (!COMMANDS.has(name)) continue; // an unknown "--word" is a comment
					items.push(command(name, m[2], lineNo));
					continue;
				}
				// if (cond) / while (cond), with { on this or the next line
				const block = /^(if|while)\s*\((.*)\)\s*\{?\s*$/i.exec(t);
				if (block) {
					if (!/\{\s*$/.test(t)) {
						while (i < lines.length && lines[i].trim() === "") i++;
						if (i < lines.length && lines[i].trim() === "{") i++;
					}
					const body = readItems(true);
					let elseBody = null;
					if (sawElse) {
						sawElse = false;
						elseBody = readItems(true);
					}
					items.push({ kind: "block", type: block[1].toLowerCase(), cond: block[2], body, elseBody, line: lineNo });
					continue;
				}
				// "name args<delimiter>" for a mysqltest command
				const word = (/^([\w-]+)/.exec(t) || [])[1];
				if (word && COMMANDS.has(word.toLowerCase()) && !isSqlStart(t)) {
					let rest = t.slice(word.length);
					let k = i;
					// a command can go on over several lines up to the delimiter
					while (!rest.trimEnd().endsWith(delimiter) && k < lines.length && !["delimiter"].includes(word.toLowerCase())) rest += "\n" + lines[k++];
					i = k;
					rest = rest.trimEnd();
					if (word.toLowerCase() === "delimiter") rest = rest.trim();
					else if (rest.endsWith(delimiter)) rest = rest.slice(0, -delimiter.length);
					// (the space before the delimiter is kept: "let $t= 'x' ;" is "'x' ", and eval echoes it)
					items.push(command(word.toLowerCase(), rest.replace(/^\s+/, ""), lineNo));
					continue;
				}
				bufLine = lineNo;
			}
			// SQL up to the delimiter (outside quotes)
			buf.push(raw);
			const joined = buf.join("\n");
			const end = findDelimiter(joined, delimiter);
			if (end >= 0) {
				const sql = joined.slice(0, end);
				items.push({ kind: "sql", sql: sql.replace(/^\s+/, ""), line: bufLine });
				buf = [];
				const rest = joined.slice(end + delimiter.length);
				if (rest.trim() && !rest.trim().startsWith("#")) {
					// more on the same line: read it again as the next item
					lines[i - 1] = rest;
					i--;
				}
			}
		}
		if (buf.length && buf.join("").trim()) items.push({ kind: "sql", sql: buf.join("\n").trim(), line: bufLine, unterminated: true });
		return items;
	}

	function command(name, args, line) {
		if (name === "delimiter") {
			// "delimiter //;" and "delimiter ;//": the new delimiter, ended by the current one ("--delimiter x" has none)
			let a = args.trim();
			if (a.length > delimiter.length && a.endsWith(delimiter)) a = a.slice(0, -delimiter.length).trim();
			delimiter = a || ";";
			return { kind: "cmd", name, args: delimiter, line };
		}
		if (["write_file", "append_file", "perl"].includes(name)) {
			// the lines up to the end marker (EOF by default) belong to the command
			const marker = (name === "perl" ? args.trim() : args.trim().split(/\s+/)[1]) || "EOF";
			const body = [];
			while (i < lines.length && lines[i].trim() !== marker.replace(/;$/, "")) body.push(lines[i++]);
			i++;
			return { kind: "cmd", name, args, body, line };
		}
		return { kind: "cmd", name, args, line };
	}

	return readItems(false);
}

// some command names are also SQL words: "set" is not a command, but "end" or "connect" could start SQL
const isSqlStart = t => /^(end\s+(if|while|loop|case)\b|connect\s+(by|to)\b)/i.test(t);

// the position of the delimiter outside strings and comments, or -1
function findDelimiter(s, delimiter) {
	let quote = null;
	for (let j = 0; j < s.length; j++) {
		const c = s[j];
		if (quote) {
			if (c === "\\" && quote !== "`") j++;
			else if (c === quote) quote = null;
			continue;
		}
		if (c === "'" || c === '"' || c === "`") {
			quote = c;
			continue;
		}
		if (s.startsWith("/*", j)) {
			const e = s.indexOf("*/", j + 2);
			if (e < 0) return -1;
			j = e + 1;
			continue;
		}
		if ((s.startsWith("-- ", j) || s[j] === "#") && (j === 0 || /\s/.test(s[j - 1]))) {
			const e = s.indexOf("\n", j);
			if (e < 0) return -1;
			j = e;
			continue;
		}
		if (s.startsWith(delimiter, j)) return j;
	}
	return -1;
}
