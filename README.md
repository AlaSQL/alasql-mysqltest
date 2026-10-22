# alasql-mysqltest

The MySQL server tests (`mysql-test/t` of the MySQL source) run against [AlaSQL](https://github.com/AlaSQL/alasql). It is the companion of [alasql-sqllogictest](https://github.com/AlaSQL/alasql-sqllogictest), [alasql-nistsqltest](https://github.com/AlaSQL/alasql-nistsqltest) and [alasql-pgsqltest](https://github.com/AlaSQL/alasql-pgsqltest): the same kind of long-running runner with a pool of workers, a Markdown report written as it goes, sampled failures, and every failure as JSON with `--debug`.

```sh
bun install
yarn test           # writes results/output.md
```

## Commands

| Command | What it does |
|---|---|
| `yarn test [flags]` | Runs `runner/run.js` and writes the report to `results/output.md`; flags go to the runner, for example `yarn test --debug` |
| `yarn triage` | Groups the statements of the last `--debug` run that did not pass by kind, the largest first |
| `yarn fetch --force` | Downloads the tests again from the MySQL source at the commit in `runner/fetch.js` (`--commit=<sha>` for another); the files are already in the repository |

| Flag | |
|---|---|
| `--only-run=FILE[,FILE]` | Run exactly these files, for example `--only-run=mysql/t/case.test` |
| `--include=REGEX`, `--exclude=REGEX` | Filter the test files by name |
| `--concurrency=N` | Number of workers (default: half the cores) |
| `--workerMB=1024` | A worker whose heap is larger than this after a file is replaced by a new one |
| `--timeout=20` | Seconds one statement may take. A statement that takes longer counts as failed, and the file is run again without it |
| `--fileTimeout=120` | Seconds one file may take; the rest of a file that takes longer is not run |
| `--debug` | Also write every statement that did not pass, with the SQL, the expected and the actual result, to `results/debug.jsonl` (replaced on every run, not committed), and where a result file stops matching its test |
| `--printAllErrors` | Print every failure instead of a sample |
| `--curiousErrorprinting=0.01` | Share of repeated failures printed besides the first of each kind (the first is always printed) |
| `--truncSQLStatement=300` | Cut printed SQL after this many characters |

`ALASQL=path/to/alasql.fs.js yarn test` tests another build (for example a local `dist/`); by default the npm package.

## How it runs

MySQL runs each test with `mysqltest`, which reads `t/<name>.test` (SQL and mysqltest commands) and writes every statement it runs, followed by its result, into `r/<name>.result`. The runner does what mysqltest does and reads the result file along with it.

1. **One file at a time per worker, one statement at a time.** Each test file starts in a fresh database `test`, as with mysqltest. The worker keeps no results: it counts each statement as it checks it, keeps the few failures it prints (the first of each kind, and a share of the rest), and with `--debug` appends the others to `results/debug.jsonl` as it goes. The main thread gets the counts and the printed text when a file is done, prints that file's section, and keeps only the totals. After each file the worker drops the file's tables and text; a worker that still holds more than `--workerMB` is replaced.
2. **The mysqltest language.** `runner/mysqltest.js` reads a test into statements and commands. The worker runs the commands the result depends on: `--echo`, `let` and `eval` (variables), `inc`, `dec`, `expr`, `--source` (the files in `include/`), `if`, `while`, `--delimiter`, `--disable_query_log`, `--disable_result_log`, `--sorted_result`, `--replace_*`. Commands that need a server or the file system (`--exec`, `connect`, `send`/`reap`, `--write_file`, ...) are not run; their output in the result file is skipped.
3. **Following the result file.** Where a test takes a branch or repeats a loop on a value from the server, the result file shows what MySQL did. The runner follows it: an `if` or `while` whose body echoes something runs when the result file shows that echo next, so an AlaSQL answer does not change the path through the test. Variables that come from a query are AlaSQL's answers; in an echoed statement they match whatever MySQL printed.
4. **Checks.** Every SQL statement is one check: the same rows (values as mysqltest prints them: `NULL`, `1` and `0` for booleans, numbers compared as numbers; rows in any order unless the statement has `ORDER BY`), an error where MySQL gives one (the code and message are not compared), or no error. `Warnings:` blocks and column names are not compared.
5. **Score.** A statement passes, fails, or is "not checked" (the result is changed by `--replace_*` or hidden by `--disable_result_log`, or the runner cannot read it). If a result file stops matching its test (a construct the runner does not follow), the rest of that file is not checked; the report says where.

Every statement goes to AlaSQL as written. The runner sets no AlaSQL options besides the result format.

## Licence

The files in `mysql/` are part of the MySQL server source, Copyright (c) Oracle and/or its affiliates, distributed under the GNU General Public License version 2 with the additional permissions in `mysql/LICENSE`. They are unchanged; `mysql/SOURCE` names the commit they come from. The runner (`runner/`) is MIT licensed.
