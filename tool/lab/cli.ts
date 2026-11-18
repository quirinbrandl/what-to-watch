// Command line of the engine lab. See tool/lab/README.md.
//
//   npx tsx tool/lab/cli.ts models
//   npx tsx tool/lab/cli.ts fetch   --users dev
//   npx tsx tool/lab/cli.ts run     --engine onecall --name luna-min --users dev --set model=<slug> --set effort=low
//   npx tsx tool/lab/cli.ts compare <run A> <run B>
//   npx tsx tool/lab/cli.ts board
//   npx tsx tool/lab/cli.ts show    <run> [user id]
import { existsSync, readdirSync } from 'node:fs';

import { labelOf } from '../../src/core/models';
import { readJson, writeJson } from '../eval-common';
import { Data, Engine, LabLlm, RunFile, UsageLimit, UserResult, acquireLlmLock, bandsOf, compare, compareEqualFame, engineInput, equalFame, runPath, runUser, summary } from './lab';
import { LAB } from './panel';

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const sets = (): Record<string, string> => {
  const out: Record<string, string> = {};
  args.forEach((a, i) => {
    if (a !== '--set' || i + 1 >= args.length) return;
    const eq = args[i + 1].indexOf('=');
    if (eq > 0) out[args[i + 1].slice(0, eq)] = args[i + 1].slice(eq + 1);
  });
  return out;
};

const f = (v: number, d = 2) => v.toFixed(d);

function line(name: string, run: RunFile, d: Data): string {
  const s = summary(run);
  return [
    name.padEnd(30),
    f(equalFame([...bandsOf(run, d).values()])).padStart(6),
    f(s.beyond).padStart(6),
    f(s.score).padStart(6),
    f(s.loved).padStart(6),
    f(s.disliked).padStart(6),
    f(s.picks, 1).padStart(6),
    f(s.unknown, 1).padStart(5),
    f(s.calls, 1).padStart(5),
    f(s.tokIn, 0).padStart(7),
    f(s.tokOut, 0).padStart(7),
    f(s.tokReason, 0).padStart(7),
    f(s.sec, 0).padStart(5),
    f(s.secP90, 0).padStart(5),
    f(s.medVotes, 0).padStart(7),
    String(s.users).padStart(4),
    s.errors ? ` ${s.errors} errors` : '',
  ].join(' ');
}
const header = `${'run'.padEnd(30)} eqfame beyond  score  loved  disl.  picks  unk. calls  tok.in tok.out reason.   sec   p90  votes    n`;

async function run(): Promise<void> {
  const engineName = arg('engine');
  const name = arg('name') ?? engineName;
  if (!engineName || !name) throw new Error('usage: run --engine <file in tool/lab/engines> --name <run name> [--users dev|test|<n>] [--set k=v]… [--rep n] [--concurrency n]');
  const set = arg('users') ?? 'dev';
  const rep = parseInt(arg('rep') ?? '0', 10) || 0;
  const conc = parseInt(arg('concurrency') ?? '4', 10) || 4;
  const params = sets();
  const engine = (await import(`./engines/${engineName}.ts`)).default as Engine;
  if (typeof engine !== 'function') throw new Error(`tool/lab/engines/${engineName}.ts has no default export`);
  await acquireLlmLock(); // runs are strictly one after another: they share the sign-in and the cache files
  const d = Data.load();
  const users = d.users(set);
  await d.ensureFilms(users.flatMap((u) => u.ratings.map((r) => r[0])));
  const llm = new LabLlm();
  const results: UserResult[] = new Array(users.length);
  let next = 0;
  let done = 0;
  let limit: UsageLimit | undefined;
  const worker = async () => {
    while (next < users.length && !limit) {
      const i = next++;
      try {
        results[i] = await runUser(users[i], d, llm, engine, params, rep);
      } catch (e) {
        if (e instanceof UsageLimit) {
          limit = e;
          return;
        }
        throw e;
      }
      done++;
      const r = results[i];
      console.error(`  ${String(done).padStart(3)}/${users.length} user ${r.user.padStart(6)}: score ${String(r.score).padStart(2)} (loved ${r.loved}, disliked ${r.disliked}), ${r.recs.length} picks, ${Math.round(r.llmSeconds)}s${r.error ? ` ERROR ${r.error}` : ''}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, users.length) }, worker));
  d.save();
  if (limit) {
    console.error(`\nUSAGE LIMIT REACHED after ${done}/${users.length} users: ${limit.message}\nFinished LLM calls are cached. Rerun the same command later to continue.`);
    process.exit(75);
  }
  const file: RunFile = { name, engine: engineName, params, set, rep, at: new Date().toISOString(), users: results };
  writeJson(runPath(name), file);
  console.log(`\n${header}\n${line(name, file, d)}`);
  console.log(`LLM calls sent in this process: ${llm.calls} (the rest came from the cache)`);
}

function load(name: string): RunFile {
  const r = readJson(runPath(name)) as RunFile | undefined;
  if (!r) throw new Error(`no run named "${name}" in ${LAB}/runs`);
  return r;
}

function cmp(): void {
  const [an, bn] = [args[1], args[2]];
  const a = load(an);
  const b = load(bn);
  const d = Data.load();
  console.log(`${header}\n${line(an, a, d)}\n${line(bn, b, d)}\n`);
  const e = compareEqualFame(a, b, d);
  console.log(`${'eqfame'.padEnd(9)} ${bn} − ${an}: ${e.diff >= 0 ? '+' : ''}${f(e.diff)}  (90% interval ${f(e.lo)} … ${f(e.hi)})  over ${e.n} users`);
  for (const field of ['beyond', 'score', 'loved', 'disliked'] as const) {
    const c = compare(a, b, field);
    console.log(`${field.padEnd(9)} ${bn} − ${an}: ${c.diff >= 0 ? '+' : ''}${f(c.diff)}  (90% interval ${f(c.lo)} … ${f(c.hi)})  better for ${c.wins}, worse for ${c.losses}, equal for ${c.ties} of ${c.n} users`);
  }
  console.log('\n"eqfame" = the score if both engines recommended equally well-known films. Decisions use "eqfame".');
  console.log('A repeat of the same engine can differ by about 0.5 on 40 users: confirm a win with --rep 1 or on more users.');
  console.log(e.lo > 0 ? `\nVERDICT: ${bn} is better (the whole interval is above 0).` : e.hi < 0 ? `\nVERDICT: ${bn} is worse (the whole interval is below 0).` : '\nVERDICT: no reliable difference (the interval includes 0).');
}

function board(): void {
  const dir = `${LAB}/runs`;
  if (!existsSync(dir)) return console.log('no runs yet');
  const runs = readdirSync(dir).filter((x) => x.endsWith('.json')).map((x) => load(x.slice(0, -5)));
  const want = arg('users');
  const d = Data.load();
  const eq = new Map(runs.map((r) => [r, equalFame([...bandsOf(r, d).values()])]));
  const shown = runs.filter((r) => !want || r.set === want).sort((a, b) => (eq.get(b) || 0) - (eq.get(a) || 0));
  console.log(header);
  for (const r of shown) console.log(`${line(r.name, r, d)}  [${r.set}] ${r.engine} ${Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(' ')}`);
}

function show(): void {
  const r = load(args[1]);
  const d = Data.load();
  const users = r.users.filter((u) => !args[2] || u.user === args[2]).slice(0, args[2] ? 1 : 3);
  for (const u of users) {
    const pu = d.panel.users.find((x) => x.id === u.user)!;
    const { hidden } = engineInput(pu, d);
    console.log(`\nuser ${u.user}: beyond fame ${u.beyond.toFixed(2)}, score ${u.score} (loved ${u.loved}, disliked ${u.disliked}, in between ${u.neutral}); dropped: ${u.dropSeen} already rated, ${u.dropLate} too new, ${u.unknownTitles} unknown titles`);
    console.log(u.recs.map((id) => `${labelOf(d.films.get(id)!)}${hidden.has(id) ? ` [${hidden.get(id)}★]` : ''}`).join(' · '));
  }
}

async function main(): Promise<void> {
  const mode = args[0];
  if (mode === 'models') console.log((await new LabLlm().models()).join('\n'));
  else if (mode === 'fetch') {
    await acquireLlmLock(); // also writes the shared film cache, so it queues like a run
    const d = Data.load();
    await d.ensureFilms(d.users(arg('users') ?? 'dev').flatMap((u) => u.ratings.map((r) => r[0])));
    d.save();
    console.log(`films in cache: ${d.films.films.size}`);
  } else if (mode === 'run') await run();
  else if (mode === 'compare') cmp();
  else if (mode === 'board') board();
  else if (mode === 'show') show();
  else console.error('usage: cli.ts <models|fetch|run|compare|board|show> …  (see tool/lab/README.md)');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
