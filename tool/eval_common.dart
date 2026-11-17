// Shared plumbing for the offline evaluation (see tool/eval.dart).
// Personal data and caches live in .eval_cache/, which is git-ignored.
import 'dart:io';
import 'dart:math' as math;

import 'package:what_to_watch/core/letterboxd.dart';
import 'package:what_to_watch/core/models.dart';
import 'package:what_to_watch/core/store.dart';
import 'package:what_to_watch/core/tmdb.dart';

const cacheDir = '.eval_cache';

class EvalData {
  final Library lib;
  final FilmCache films;
  final Tmdb tmdb;
  EvalData(this.lib, this.films, this.tmdb);
  Future<void> save() => JsonFile('$cacheDir/films.json').write(films.toJson());
}

/// Loads a Letterboxd export (folder or ZIP), matches it to TMDB and fetches
/// details. Matches and film details are cached, so later runs are offline.
Future<EvalData> loadExport(String path, {String region = 'DE'}) async {
  final LbExport ex;
  if (FileSystemEntity.isDirectorySync(path)) {
    final files = <String, String>{};
    for (final f in Directory(path).listSync(recursive: true).whereType<File>()) {
      if (!f.path.endsWith('.csv')) continue;
      final parts = f.path.substring(path.length).split('/').where((p) => p.isNotEmpty).toList();
      final parent = parts.length > 1 ? parts[parts.length - 2] : '';
      files[const {'likes', 'lists', 'deleted', 'orphaned'}.contains(parent) ? '$parent/${parts.last}' : parts.last] = f.readAsStringSync();
    }
    ex = parseLetterboxdFiles(files);
  } else {
    ex = parseLetterboxdZip(File(path).readAsBytesSync());
  }
  final films = FilmCache();
  final cached = await JsonFile('$cacheDir/films.json').read();
  if (cached != null) films.load(cached);
  final tmdb = Tmdb(films);
  final matchFile = JsonFile('$cacheDir/match.json');
  final match = await matchFile.read() ?? {};
  final todo = ex.films.values.where((f) => !match.containsKey(f.key)).toList();
  if (todo.isNotEmpty) {
    stderr.writeln('Matching ${todo.length} films to TMDB…');
    await Future.wait(todo.map((f) async {
      match[f.key] = (await matchTitle(tmdb, f.name, f.year))?.id;
    }));
    await matchFile.write(match);
  }
  for (final f in ex.films.values) {
    f.tmdbId = match[f.key] as int?;
  }
  final lib = Library();
  applyExport(lib, ex);
  final missing = lib.entries.keys.where((id) => films[id]?.full != true).toList();
  if (missing.isNotEmpty) {
    stderr.writeln('Fetching details for ${missing.length} films…');
    await tmdb.detailsAll(missing, region, providerMaxAgeDays: 9999);
  }
  final data = EvalData(lib, films, tmdb);
  if (missing.isNotEmpty) await data.save();
  return data;
}

// ---------------------------------------------------------------- metrics

/// Probability that a random hit (y ≥ cut) is scored above a random miss.
double auc(List<double> pred, List<double> y, {double cut = 3}) {
  var pairs = 0, wins = 0.0;
  for (var i = 0; i < y.length; i++) {
    if (y[i] < cut) continue;
    for (var j = 0; j < y.length; j++) {
      if (y[j] >= cut) continue;
      pairs++;
      wins += pred[i] > pred[j] ? 1 : (pred[i] == pred[j] ? 0.5 : 0);
    }
  }
  return pairs == 0 ? double.nan : wins / pairs;
}

List<double> _ranks(List<double> v) {
  final idx = List.generate(v.length, (i) => i)..sort((a, b) => v[a].compareTo(v[b]));
  final r = List.filled(v.length, 0.0);
  var i = 0;
  while (i < idx.length) {
    var j = i;
    while (j + 1 < idx.length && v[idx[j + 1]] == v[idx[i]]) {
      j++;
    }
    for (var k = i; k <= j; k++) {
      r[idx[k]] = (i + j) / 2 + 1;
    }
    i = j + 1;
  }
  return r;
}

double spearman(List<double> a, List<double> b) {
  final ra = _ranks(a), rb = _ranks(b);
  final ma = ra.reduce((x, y) => x + y) / ra.length, mb = rb.reduce((x, y) => x + y) / rb.length;
  var num = 0.0, da = 0.0, db = 0.0;
  for (var i = 0; i < ra.length; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) * (ra[i] - ma);
    db += (rb[i] - mb) * (rb[i] - mb);
  }
  return num / math.sqrt(da * db);
}

/// One evaluation fold: predictions for held-out films and their true ratings.
class Fold {
  final List<double> pred = [], y = [];
}

class Report {
  final String name;
  final double aucMiss, aucLoved, rho, hit, loved, meanTop, missTop;
  Report(this.name, this.aucMiss, this.aucLoved, this.rho, this.hit, this.loved, this.meanTop, this.missTop);

  /// "The engine recommends the top [k] of each fold" — what share of those
  /// did the user rate ≥ 3★ (hit), ≥ 4★ (loved), and what was the mean?
  factory Report.of(String name, List<Fold> folds, {int k = 10}) {
    final p = [for (final f in folds) ...f.pred], y = [for (final f in folds) ...f.y];
    var top = <double>[];
    for (final f in folds) {
      final idx = List.generate(f.y.length, (i) => i)..sort((a, b) => f.pred[b].compareTo(f.pred[a]));
      top.addAll(idx.take(k).map((i) => f.y[i]));
    }
    double share(bool Function(double) t) => top.where(t).length / top.length;
    return Report(name, auc(p, y), auc(p, y, cut: 4), spearman(p, y), share((v) => v >= 3), share((v) => v >= 4),
        top.reduce((a, b) => a + b) / top.length, top.where((v) => v < 3).length.toDouble());
  }

  static String header() =>
      '${'model'.padRight(26)} AUC≥3  AUC≥4  rho    hit@10  loved@10  mean@10  misses';
  @override
  String toString() =>
      '${name.padRight(26)} ${aucMiss.toStringAsFixed(3)}  ${aucLoved.toStringAsFixed(3)}  ${rho.toStringAsFixed(3).padLeft(5)}  ${(hit * 100).toStringAsFixed(1).padLeft(5)}%  ${(loved * 100).toStringAsFixed(1).padLeft(6)}%  ${meanTop.toStringAsFixed(2).padLeft(6)}  ${missTop.toStringAsFixed(0).padLeft(5)}';
}

/// Stratified k-fold split of rated film ids (stable for a given seed).
List<List<int>> kfold(Library lib, {int k = 5, int seed = 7}) {
  final rnd = math.Random(seed);
  final rated = lib.rated.toList()..sort((a, b) => a.id.compareTo(b.id));
  rated.shuffle(rnd);
  rated.sort((a, b) => a.rating!.compareTo(b.rating!)); // stable sort keeps the shuffle within a rating
  final folds = List.generate(k, (_) => <int>[]);
  for (var i = 0; i < rated.length; i++) {
    folds[i % k].add(rated[i].id);
  }
  return folds;
}
