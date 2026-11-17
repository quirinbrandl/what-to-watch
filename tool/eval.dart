// Offline evaluation of the recommendation engine.
//
//   dart run tool/eval.dart local  --export <letterboxd export dir or zip>
//   dart run tool/eval.dart judge  --export … [--model <slug>]   (uses the LLM)
//   dart run tool/eval.dart blind  --export … [--model <slug>]   (uses the LLM)
//
// Metric: ratings are held out in 5 stratified folds. For each fold the engine
// only sees the other four and must rank the hidden films. We report how well
// it separates films rated ≥ 3★ ("worth my evening") from misses (AUC), and
// what the user actually thought of the 10 films per fold it would have
// recommended first (hit@10 = share ≥ 3★, loved@10 = share ≥ 4★).
// It is one person and ~200 ratings: treat every number as a rough signal.
import 'dart:io';

import 'package:what_to_watch/core/engine/taste.dart';

import 'eval_common.dart';
import 'eval_llm.dart';

String? _arg(List<String> a, String name) {
  final i = a.indexOf('--$name');
  return i >= 0 && i + 1 < a.length ? a[i + 1] : null;
}

Future<void> main(List<String> args) async {
  final mode = args.isEmpty ? 'local' : args.first;
  if (mode == 'signin') {
    await evalSignIn(adb: args.contains('--adb'));
    exit(0);
  }
  final export = _arg(args, 'export');
  if (export == null) {
    stderr.writeln('usage: dart run tool/eval.dart <local|judge|blind|signin> --export <dir|zip> [--model slug]');
    exit(64);
  }
  final data = await loadExport(export);
  final lib = data.lib;
  final ys = [for (final e in lib.rated) e.rating!];
  stdout.writeln('Library: ${ys.length} rated · ${lib.watchlist.length} watchlist · ${lib.unmatched.length} unmatched'
      ' · base rates: ≥3★ ${(ys.where((y) => y >= 3).length / ys.length * 100).toStringAsFixed(1)}%'
      ' · ≥4★ ${(ys.where((y) => y >= 4).length / ys.length * 100).toStringAsFixed(1)}%'
      ' · mean ${(ys.reduce((a, b) => a + b) / ys.length).toStringAsFixed(2)}');
  if (lib.unmatched.isNotEmpty) stdout.writeln('Unmatched: ${lib.unmatched.join('; ')}');

  switch (mode) {
    case 'local':
      await _local(data, args.contains('--ablate'));
    case 'judge':
      await evalJudge(data, model: _arg(args, 'model'), folds: int.tryParse(_arg(args, 'folds') ?? '') ?? 5);
    case 'blind':
      await evalBlind(data, model: _arg(args, 'model'), folds: int.tryParse(_arg(args, 'folds') ?? '') ?? 2);
    default:
      stderr.writeln('unknown mode $mode');
  }
  exit(0);
}

List<Fold> cvLocal(EvalData d, TasteOptions opt, {int repeats = 3, double Function(dynamic film)? baseline}) {
  final out = <Fold>[];
  for (var rep = 0; rep < repeats; rep++) {
    for (final fold in kfold(d.lib, seed: 7 + rep)) {
      final hide = fold.toSet();
      final model = baseline == null ? TasteModel.fromLibrary(d.lib, d.films, hide: hide, opt: opt) : null;
      final f = Fold();
      for (final id in fold) {
        final film = d.films[id];
        if (film == null) continue;
        f.pred.add(baseline != null ? baseline(film) : model!.predict(film).rating);
        f.y.add(d.lib[id]!.rating!);
      }
      out.add(f);
    }
  }
  return out;
}

Future<void> _local(EvalData d, bool ablate) async {
  stdout.writeln('\n5-fold CV × 3 repeats (top 10 of ~39 per fold)\n${Report.header()}');
  stdout.writeln(Report.of('TMDB score (baseline)', cvLocal(d, const TasteOptions(), baseline: (f) => f.score as double)));
  stdout.writeln(Report.of('taste model', cvLocal(d, const TasteOptions())));
  if (!ablate) return;
  stdout.writeln(Report.of('  unconstrained weights', cvLocal(d, const TasteOptions(nonNegative: false))));
  stdout.writeln(Report.of('  no watchlist evidence', cvLocal(d, const TasteOptions(useWatchlist: false))));
  for (final l in [5.0, 15.0, 80.0, 200.0]) {
    stdout.writeln(Report.of('  lambda $l', cvLocal(d, TasteOptions(lambda: l))));
  }
  for (final k in [6, 25]) {
    stdout.writeln(Report.of('  knn $k', cvLocal(d, TasteOptions(knn: k))));
  }
  for (final n in TasteModel.names) {
    stdout.writeln(Report.of('  without $n', cvLocal(d, TasteOptions(drop: {n}))));
  }
  for (final n in TasteModel.names) {
    stdout.writeln(Report.of('  only $n', cvLocal(d, TasteOptions(drop: TasteModel.names.toSet()..remove(n)))));
  }
  final m = TasteModel.fromLibrary(d.lib, d.films);
  stdout.writeln('\nStack weights (standardised): ${m.weights.map((k, v) => MapEntry(k, v.toStringAsFixed(3)))}');
  stdout.writeln('Likes: genres ${m.top('g')} · directors ${m.top('d')} · keywords ${m.top('k', n: 10)}');
  stdout.writeln('Dislikes: genres ${m.top('g', positive: false)} · keywords ${m.top('k', positive: false)}');
}
