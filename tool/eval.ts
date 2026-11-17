// Offline evaluation of the recommendation engine.
//
//   npm run eval -- local  --export <letterboxd export dir or zip> [--ablate]
//   npm run eval -- signin [--adb]                     (LLM access for the modes below)
//   npm run eval -- judge  --export … [--model <slug>] (uses the LLM)
//   npm run eval -- blind  --export … [--model <slug>] (uses the LLM)
//
// Metric: ratings are held out in 5 stratified folds. For each fold the engine
// only sees the other four and must rank the hidden films. We report how well
// it separates films rated ≥ 3★ ("worth my evening") from misses (AUC), and
// what the user actually thought of the 10 films per fold it would have
// recommended first (hit@10 = share ≥ 3★, loved@10 = share ≥ 4★).
// It is one person and ~200 ratings: treat every number as a rough signal.
import { TasteModel, TasteOptions, defaultTaste } from '../src/core/engine/taste';
import { Film, scoreOf } from '../src/core/models';

import { EvalData, Fold, kfold, loadExport, report, reportHeader } from './eval-common';
import { evalBlind, evalJudge, evalSignIn } from './eval-llm';

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};

function cvLocal(d: EvalData, opt: Partial<TasteOptions>, baseline?: (f: Film) => number, repeats = 3): Fold[] {
  const o = { ...defaultTaste, ...opt };
  const out: Fold[] = [];
  for (let rep = 0; rep < repeats; rep++) {
    for (const fold of kfold(d.lib, 5, 7 + rep)) {
      const model = baseline ? undefined : TasteModel.fromLibrary(d.lib, d.films, new Set(fold), o);
      const f: Fold = { pred: [], y: [] };
      for (const id of fold) {
        const film = d.films.get(id);
        if (!film) continue;
        f.pred.push(baseline ? baseline(film) : model!.predict(film).rating);
        f.y.push(d.lib.get(id)!.rating!);
      }
      out.push(f);
    }
  }
  return out;
}

function local(d: EvalData, ablate: boolean): void {
  console.log(`\n5-fold CV × 3 repeats (top 10 of ~39 per fold)\n${reportHeader}`);
  console.log(report('TMDB score (baseline)', cvLocal(d, {}, scoreOf)));
  console.log(report('taste model', cvLocal(d, {})));
  if (!ablate) return;
  console.log(report('  unconstrained weights', cvLocal(d, { nonNegative: false })));
  console.log(report('  no watchlist evidence', cvLocal(d, { useWatchlist: false })));
  for (const l of [5, 60, 200]) console.log(report(`  lambda ${l}`, cvLocal(d, { lambda: l })));
  for (const n of TasteModel.names) console.log(report(`  without ${n}`, cvLocal(d, { drop: new Set([n]) })));
  const m = TasteModel.fromLibrary(d.lib, d.films);
  console.log(`\nStack weights (standardised): ${JSON.stringify(Object.fromEntries(Object.entries(m.weights).map(([k, v]) => [k, +v.toFixed(3)])))}`);
  console.log(`Likes: genres ${m.top('g').join(', ')} · directors ${m.top('d').join(', ')} · themes ${m.top('k', 10).join(', ')}`);
  console.log(`Dislikes: genres ${m.top('g', 6, false).join(', ')} · themes ${m.top('k', 6, false).join(', ')}`);
}

async function main(): Promise<void> {
  const mode = args[0] ?? 'local';
  if (mode === 'signin') {
    await evalSignIn(args.includes('--adb'));
    return;
  }
  const path = arg('export');
  if (!path) {
    console.error('usage: npm run eval -- <local|judge|blind|signin> --export <dir|zip> [--model slug] [--folds n] [--ablate]');
    process.exit(64);
  }
  const d = await loadExport(path);
  const ys = d.lib.rated.map((e) => e.rating!);
  const pct = (t: (y: number) => boolean) => ((ys.filter(t).length / ys.length) * 100).toFixed(1);
  console.log(
    `Library: ${ys.length} rated · ${d.lib.watchlist.length} watchlist · ${d.lib.unmatched.length} unmatched · base rates: ≥3★ ${pct((y) => y >= 3)}% · ≥4★ ${pct((y) => y >= 4)}% · mean ${(ys.reduce((a, b) => a + b, 0) / ys.length).toFixed(2)}`,
  );
  if (d.lib.unmatched.length) console.log(`Unmatched: ${d.lib.unmatched.join('; ')}`);
  const folds = parseInt(arg('folds') ?? '', 10);
  if (mode === 'local') local(d, args.includes('--ablate'));
  else if (mode === 'judge') await evalJudge(d, arg('model'), Number.isFinite(folds) ? folds : 5);
  else if (mode === 'blind') await evalBlind(d, arg('model'), Number.isFinite(folds) ? folds : 2, arg('prompt'));
  else console.error(`unknown mode ${mode}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
