# Engine lab

Offline experiments on the recommendation engine. Scenario: a person's film ratings go in, 24 recommendations come out. No typed request, no filters.

## The test

- **People:** 200 MovieLens users (150–400 ratings, still rating in 2023), fixed by a seed. `dev` = 40 users for experiments, `test` = 80 users held back to confirm a final result, `spare` = 80 more.
- **Hidden films:** 30% of each person's rated films are hidden from the engine.
- **Cutoff:** only films released up to the date of the person's last rating count.
- **Score:** among the first 24 valid recommendations, +1 for each hidden film the person rated 4★ or higher, −1 for each rated below 3★.
- **Equal fame (`eqfame`):** well-known films are in everybody's history, so an engine that leans towards them collects more hits without understanding the person any better. `eqfame` counts the hits inside fame bands and re-weights them to one fixed mix of bands: the score if every engine recommended equally well-known films (see `equalFame` in `lab.ts`). **Decisions use `eqfame`**; `score` is reported next to it. `beyond` is an older, weaker correction (score minus what the picks would score from fame alone) and is kept for reference.
- **What the test cannot see:** a recommended film the person never rated counts as nothing, even if they would love it. Wording that asks for discoveries therefore lowers every number here.
- **Noise:** the same engine run twice can differ by about 0.5 on the 40 dev users, sometimes more. `compare` prints a 90% interval over people, but that interval does not include the LLM's own run-to-run variation. Treat a win on dev as a candidate: confirm it with `--rep 1` or on the test users.

## Commands

Run from the repository root. Only one run can use the LLM at a time; a second run waits by itself.

```sh
npx tsx tool/lab/cli.ts run --engine <file in engines/> --name <run name> --users dev --set model=gpt-6.2-sol --set effort=low [--set k=v …]
npx tsx tool/lab/cli.ts compare <run A> <run B>     # B minus A, per person, with interval and verdict
npx tsx tool/lab/cli.ts board --users dev           # all runs, best first
npx tsx tool/lab/cli.ts show <run> [user id]        # the picks, hidden films marked with the real rating
```

`run` flags: `--users dev|test|spare|<n>` (a number = the first n dev users, for a smoke test), `--rep <n>` (a deliberate repeat with fresh LLM answers), `--concurrency <n>` (default 4).

LLM answers are cached on disk by prompt, so repeating a run costs nothing, and nothing is lost when the ChatGPT plan's usage limit is reached: the run waits and retries every 10 minutes for up to 6 hours, then stops with exit code 75 and continues when the same command is run again. Without a connection it tries again every minute for an hour. A closed laptop lid pauses everything; a person whose call failed is recorded as an error and is retried when the same command is run again.

Columns of `run` / `board`: `eqfame`, `beyond`, `score`, `loved`, `disl.` (per person), `picks` (valid recommendations, max 24), `unk.` (titles not found on TMDB), `calls`, `tok.in`, `tok.out`, `reason.` (tokens per person), `sec` and `p90` (seconds of LLM time per person), `votes` (median TMDB vote count of the picks: how well known they are), `n` (people).

## The app's engine

`engines/app.ts` runs the engine as the app ships it (`src/core/engine/recommender.ts`) with no typed request, the dial in the middle and no filter except the test's year limit. In that state the app sends the questions of `engines/combo.ts` (`k=60`, `judge=stars`, `judgeRatings=words`) word for word, so most of its answers come from the cache. Run it after any change to the app's engine; on the test people it must stay at about 6.7 at equal fame:

```sh
npx tsx tool/lab/cli.ts run --engine app --name test-app --users test --set model=gpt-6.2-sol --set effort=low
npx tsx tool/lab/cli.ts compare test-judge test-app
```

Runs named `shipped-…` and `test-shipped`, and `onecall` runs with `prompt=app`, were made with the pipeline the app had before (taste model, TMDB sources, judge, blend; last in git at commit 6a6cca2). Their results are kept; that code is gone.

## Writing an engine

One file in `tool/lab/engines/`, default export of type `Engine` (see `lab.ts`): it receives the visible ratings and returns TMDB film ids, best first. The harness removes films the person already rated, films released after their cutoff and repeats, then scores the first 24. Start from `engines/onecall.ts`.

- `io.llm({ developer, user })` makes one LLM call (model and effort come from `--set model=… --set effort=…`).
- `io.resolveAll([{ t, y }])` turns titles into TMDB films; `io.param(name, fallback)` / `io.num(name, fallback)` read `--set` values.
- `io.data.films` (film cache), `io.data.tmdb` (TMDB client), `io.library()` (the visible ratings as an app `Library`).

## Rules

- An engine never sees the hidden films. Do not read `panel.json` or `mlstats.json` from an engine.
- Experiments run on `dev`. `test` is only for the final confirmation.
- Data lives in the git-ignored `.eval_cache/` (`movielens/` = MovieLens 32M, research use only; `lab/` = panel, film cache, LLM cache, run results). Never commit it.
- Rebuild the panel with `npx tsx tool/lab/panel.ts` (same seed, same panel).
