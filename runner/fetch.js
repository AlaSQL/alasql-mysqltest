/**
 * Downloads the MySQL server tests (mysql-test of the MySQL server source) at a fixed commit and puts the parts
 * this runner uses into mysql/:
 *
 *   mysql/t/         the test files (*.test) of the main suite
 *   mysql/r/         the expected result of each test (*.result)
 *   mysql/include/   the files the tests include with --source
 *   mysql/LICENSE, mysql/README, mysql/SOURCE (the commit)
 *
 * The MySQL repository is large, so only these folders are fetched (a sparse, shallow git clone). The files
 * are used as MySQL has them: the runner never edits a file. mysql-test/std_data (data files, 400 MB) is left
 * out; statements that read from it fail.
 *
 *   bun run runner/fetch.js [--force] [--commit=<sha>]
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const commitArg = process.argv.find(a => a.startsWith("--commit="));
const commit = commitArg ? commitArg.split("=")[1] : "561753af986c3c006c4b6c7caa8359748fb55b22"; // trunk, 2026-10-20
const target = path.join(root, "mysql");

if (fs.existsSync(path.join(target, "t")) && !process.argv.includes("--force")) {
	console.log("mysql/ is already there (use --force to fetch it again)");
	process.exit(0);
}

const git = (args, cwd) => {
	const r = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error("git " + args.join(" ") + " failed: " + r.stderr.toString());
};

const tmp = fs.mkdtempSync(path.join(root, ".fetch-"));
try {
	console.log(`Fetching mysql/mysql-server@${commit} (mysql-test only)`);
	git(["init", "-q"], tmp);
	git(["remote", "add", "origin", "https://github.com/mysql/mysql-server.git"], tmp);
	git(["sparse-checkout", "set", "--no-cone", "/mysql-test/t/", "/mysql-test/r/", "/mysql-test/include/", "/LICENSE", "/README"], tmp);
	git(["fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", commit], tmp);
	git(["checkout", "-q", "FETCH_HEAD"], tmp);
	fs.rmSync(target, { recursive: true, force: true });
	fs.mkdirSync(target);
	for (const d of ["t", "r", "include"]) fs.cpSync(path.join(tmp, "mysql-test", d), path.join(target, d), { recursive: true });
	for (const f of ["LICENSE", "README"]) fs.copyFileSync(path.join(tmp, f), path.join(target, f));
	fs.writeFileSync(path.join(target, "SOURCE"), `mysql/mysql-server@${commit}\n`);
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
const count = d => fs.readdirSync(path.join(target, d)).length;
console.log(`mysql/ ready: ${count("t")} files in t/, ${count("r")} in r/, ${count("include")} in include/`);
