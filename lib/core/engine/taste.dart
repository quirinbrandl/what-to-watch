import 'dart:math' as math;

import '../models.dart';
import '../tmdb.dart';

/// One piece of taste evidence: a film with a (pseudo-)rating and a weight.
class Sample {
  final Film film;
  final double y;
  final double w;
  final bool rated;
  late Map<String, double> vec; // idf-weighted, L2-normalised features
  late List<double> x; // leave-one-out stack features (rated samples only)
  Sample(this.film, this.y, this.w, {this.rated = true});
}

class Neighbor {
  final Film film;
  final double sim;
  final double rating;
  const Neighbor(this.film, this.sim, this.rating);
}

class Prediction {
  final double rating; // predicted stars, 0.5–5
  final List<Neighbor> neighbors; // most similar films the user rated
  final List<double> x;
  const Prediction(this.rating, this.neighbors, this.x);
}

class TasteOptions {
  final double lambda; // ridge strength of the stacker
  final bool useWatchlist; // watchlist as weak positive evidence
  final int knn;
  final Set<String> drop; // feature names to disable (for ablations)
  final bool nonNegative;
  const TasteOptions({this.lambda = 20, this.useWatchlist = true, this.knn = 12, this.drop = const {}, this.nonNegative = true});
}

class _Stat {
  double s = 0, w = 0;
}

/// The local, deterministic taste model.
///
/// It learns how much the user likes each genre, keyword, director, actor,
/// decade and language (shrunk mean deviation from their own average), finds
/// the most similar films they rated (kNN on idf-weighted features), reads the
/// TMDB recommendation graph around their films, and stacks all of that with
/// a ridge regression fitted on leave-one-out features of their own ratings.
class TasteModel {
  static const names = ['genre', 'keyword', 'director', 'cast', 'decade', 'lang', 'knn', 'collab', 'collabN', 'vote', 'votes'];
  static const _shrink = {'g': 3.0, 'k': 2.0, 'd': 1.5, 'c': 2.0, 'y': 5.0, 'l': 5.0};
  static const _typeW = {'g': 1.0, 'k': 1.0, 'd': 2.0, 'c': 0.8, 'y': 0.5, 'l': 0.6};
  static const _defaults = [0.8, 0.6, 0.8, 0.4, 0.4, 0.4, 0.8, 0.8, 0.15, 0.45, 0.05];

  final TasteOptions opt;
  final List<Sample> samples;
  final double mean;
  final int rated;
  final _stats = <String, _Stat>{};
  final _df = <String, int>{};
  final _byId = <int, Sample>{};
  final _recBy = <int, List<Sample>>{};
  final kwNames = <int, String>{};
  late final List<double> _mu, _sd, _beta;
  late final bool learned;

  TasteModel._(this.samples, this.mean, this.rated, this.opt);

  static Iterable<String> featuresOf(Film f) sync* {
    for (final g in f.genres) {
      yield 'g:$g';
    }
    for (final k in f.keywords) {
      yield 'k:${k.id}';
    }
    for (final d in f.directors) {
      yield 'd:$d';
    }
    for (final c in f.cast.take(4)) {
      yield 'c:$c';
    }
    if (f.decade != null) yield 'y:${f.decade}';
    if (f.lang != null) yield 'l:${f.lang}';
  }

  /// Turns a library into weighted samples. [hide] removes films (used by
  /// the evaluation to hold ratings out).
  static List<Sample> samplesFrom(Library lib, FilmCache films, {Set<int> hide = const {}, TasteOptions opt = const TasteOptions()}) {
    final ratings = [for (final e in lib.rated) if (!hide.contains(e.id)) e.rating!];
    final mu = ratings.isEmpty ? 3.4 : ratings.reduce((a, b) => a + b) / ratings.length;
    final out = <Sample>[];
    for (final e in lib.entries.values) {
      if (hide.contains(e.id)) continue;
      final f = films[e.id];
      if (f == null || !f.full) continue;
      final r = e.rating;
      if (r != null) {
        out.add(Sample(f, r, 1 + (e.liked ? 0.25 : 0) + (e.favorite ? 0.5 : 0) + (e.rewatched ? 0.25 : 0)));
      } else if (e.notInterested) {
        out.add(Sample(f, math.min(2.25, mu - 1), 0.5, rated: false));
      } else if (e.watched && e.liked) {
        out.add(Sample(f, math.max(4.0, mu + 0.5), 0.7, rated: false));
      } else if (e.watchlist && opt.useWatchlist) {
        out.add(Sample(f, math.min(4.25, mu + 0.5), 0.3, rated: false));
      }
    }
    return out;
  }

  factory TasteModel.fromLibrary(Library lib, FilmCache films, {Set<int> hide = const {}, TasteOptions opt = const TasteOptions()}) =>
      TasteModel.build(samplesFrom(lib, films, hide: hide, opt: opt), opt: opt);

  factory TasteModel.build(List<Sample> samples, {TasteOptions opt = const TasteOptions()}) {
    final rs = samples.where((s) => s.rated).toList();
    final mean = rs.isEmpty ? 3.4 : rs.map((s) => s.y).reduce((a, b) => a + b) / rs.length;
    final m = TasteModel._(samples, mean, rs.length, opt);
    for (final s in samples) {
      m._byId[s.film.id] = s;
      for (final k in s.film.keywords) {
        m.kwNames[k.id] = k.name;
      }
      for (final f in featuresOf(s.film)) {
        final st = m._stats.putIfAbsent(f, _Stat.new);
        st.s += s.w * (s.y - mean);
        st.w += s.w;
        m._df.update(f, (v) => v + 1, ifAbsent: () => 1);
      }
      for (final r in s.film.recs) {
        m._recBy.putIfAbsent(r, () => []).add(s);
      }
    }
    for (final s in samples) {
      s.vec = m._vector(s.film);
    }
    // Stack: fit on leave-one-out features so the weights are honest.
    for (final s in rs) {
      s.x = m._features(s.film, self: s);
    }
    final d = names.length;
    m._mu = List.filled(d, 0);
    m._sd = List.filled(d, 1);
    m.learned = rs.length >= 25;
    if (!m.learned) {
      m._beta = List.of(_defaults);
      return m;
    }
    for (var j = 0; j < d; j++) {
      final col = [for (final s in rs) s.x[j]];
      final mu = col.reduce((a, b) => a + b) / col.length;
      final v = col.map((c) => (c - mu) * (c - mu)).reduce((a, b) => a + b) / col.length;
      m._mu[j] = mu;
      m._sd[j] = v < 1e-9 ? 0 : math.sqrt(v);
    }
    final a = [for (var i = 0; i < d; i++) List.filled(d, 0.0)];
    final b = List.filled(d, 0.0);
    for (final s in rs) {
      final z = m._z(s.x);
      for (var i = 0; i < d; i++) {
        b[i] += z[i] * (s.y - mean);
        for (var j = 0; j < d; j++) {
          a[i][j] += z[i] * z[j];
        }
      }
    }
    for (var i = 0; i < d; i++) {
      a[i][i] += opt.lambda;
    }
    // Non-negative ridge: an affinity can only ever help. Features whose
    // weight comes out negative are noise on small libraries; drop and refit.
    final active = List.generate(d, (i) => i);
    while (true) {
      final sub = _solve([for (final i in active) [for (final j in active) a[i][j]]], [for (final i in active) b[i]]);
      var worst = -1;
      for (var k = 0; k < active.length; k++) {
        if (names[active[k]] != 'votes' && sub[k] < 0 && (worst < 0 || sub[k] < sub[worst])) worst = k;
      }
      if (worst < 0 || !opt.nonNegative) {
        m._beta = List.filled(d, 0.0);
        for (var k = 0; k < active.length; k++) {
          m._beta[active[k]] = sub[k];
        }
        break;
      }
      active.removeAt(worst);
    }
    return m;
  }

  List<double> _z(List<double> x) => [
        for (var j = 0; j < x.length; j++) (_sd[j] == 0 || opt.drop.contains(names[j])) ? 0.0 : (x[j] - _mu[j]) / _sd[j]
      ];

  double _idf(String f) => math.log((samples.length + 1) / ((_df[f] ?? 0) + 0.5)) * _typeW[f.substring(0, 1)]!;

  Map<String, double> _vector(Film film) {
    final v = <String, double>{};
    var norm = 0.0;
    for (final f in featuresOf(film)) {
      final w = _idf(f);
      v[f] = w;
      norm += w * w;
    }
    if (norm > 0) {
      final n = math.sqrt(norm);
      v.updateAll((_, w) => w / n);
    }
    return v;
  }

  static double _dot(Map<String, double> a, Map<String, double> b) {
    if (a.length > b.length) return _dot(b, a);
    var s = 0.0;
    a.forEach((k, v) {
      final o = b[k];
      if (o != null) s += v * o;
    });
    return s;
  }

  List<(Sample, double)> _nearest(Film film, Map<String, double> vec, {Sample? self}) {
    final sims = <(Sample, double)>[];
    for (final s in samples) {
      if (identical(s, self) || s.film.id == film.id) continue;
      final sim = _dot(vec, s.vec);
      if (sim > 0.02) sims.add((s, sim));
    }
    sims.sort((a, b) => b.$2.compareTo(a.$2));
    return sims.length > opt.knn ? sims.sublist(0, opt.knn) : sims;
  }

  /// Raw stack features. With [self], the sample's own contribution is
  /// removed everywhere (leave-one-out).
  List<double> _features(Film film, {Sample? self}) {
    final exS = self == null ? 0.0 : self.w * (self.y - mean);
    final exW = self?.w ?? 0.0;
    final sums = <String, double>{}, counts = <String, int>{};
    var dirBest = 0.0;
    for (final f in featuresOf(film)) {
      final st = _stats[f];
      if (st == null) continue;
      final w = st.w - exW;
      if (w <= 1e-9) continue;
      final t = f.substring(0, 1);
      final a = (st.s - exS) / (w + _shrink[t]!);
      sums[t] = (sums[t] ?? 0) + a;
      counts[t] = (counts[t] ?? 0) + 1;
      if (t == 'd' && a.abs() > dirBest.abs()) dirBest = a;
    }
    double mean_(String t) => counts[t] == null ? 0 : sums[t]! / counts[t]!;
    double root(String t) => counts[t] == null ? 0 : sums[t]! / math.sqrt(counts[t]! + 1);

    final near = _nearest(film, self?.vec ?? _vector(film), self: self);
    var ks = 0.0, kw = 0.0;
    for (final (s, sim) in near) {
      ks += sim * s.w * (s.y - mean);
      kw += sim * s.w;
    }
    final knn = ks / (kw + 0.3);

    // TMDB recommendation graph: library films that recommend this one, or
    // that this one recommends.
    final nb = <Sample>{...?_recBy[film.id]};
    for (final r in film.recs) {
      final s = _byId[r];
      if (s != null) nb.add(s);
    }
    nb.remove(self);
    var cs = 0.0, cw = 0.0;
    for (final s in nb) {
      cs += s.w * (s.y - mean);
      cw += s.w;
    }
    return [
      mean_('g'),
      root('k'),
      dirBest,
      root('c'),
      mean_('y'),
      mean_('l'),
      knn,
      cs / (cw + 1.5),
      math.log(1 + nb.length),
      film.score - 6.3,
      math.log(film.votes + 1) / math.ln10 - 3.5,
    ];
  }

  Prediction predict(Film film) {
    final self = _byId[film.id];
    final x = _features(film, self: self);
    var r = mean;
    if (learned) {
      final z = _z(x);
      for (var j = 0; j < z.length; j++) {
        r += _beta[j] * z[j];
      }
    } else {
      for (var j = 0; j < x.length; j++) {
        if (!opt.drop.contains(names[j])) r += _beta[j] * x[j];
      }
    }
    final near = _nearest(film, self?.vec ?? _vector(film), self: self);
    return Prediction(
      r.clamp(0.5, 5.0).toDouble(),
      [for (final (s, sim) in near) if (s.rated) Neighbor(s.film, sim, s.y)],
      x,
    );
  }

  /// Leave-one-out prediction for a rated sample (diagnostics).
  Map<String, double> get weights => {for (var j = 0; j < names.length; j++) names[j]: _beta[j]};

  /// Strongest likes/dislikes of one feature type, for prompts and stats.
  /// [type] is one of g, k, d, c, y, l.
  List<String> top(String type, {int n = 6, bool positive = true, double minWeight = 2.5}) {
    final l = <(String, double)>[];
    _stats.forEach((f, st) {
      if (!f.startsWith('$type:') || st.w < minWeight) return;
      final a = st.s / (st.w + _shrink[type]!);
      if (positive ? a > 0.08 : a < -0.08) l.add((f.substring(2), a));
    });
    l.sort((a, b) => positive ? b.$2.compareTo(a.$2) : a.$2.compareTo(b.$2));
    return [
      for (final (f, _) in l.take(n))
        switch (type) {
          'g' => kGenres[int.parse(f)] ?? f,
          'k' => kwNames[int.parse(f)] ?? f,
          'y' => '${f}s',
          'l' => kLanguages[f] ?? f,
          _ => f,
        }
    ];
  }

  /// Keyword ids the user responds to most (for TMDB discover).
  List<int> topKeywordIds({int n = 8}) {
    final l = <(int, double)>[];
    _stats.forEach((f, st) {
      if (!f.startsWith('k:') || st.w < 2.5) return;
      final a = st.s / (st.w + 2.0);
      if (a > 0.1) l.add((int.parse(f.substring(2)), a * math.log(1 + st.w)));
    });
    l.sort((a, b) => b.$2.compareTo(a.$2));
    return [for (final (id, _) in l.take(n)) id];
  }

  static List<double> _solve(List<List<double>> a, List<double> b) {
    final n = b.length;
    for (var i = 0; i < n; i++) {
      var p = i;
      for (var r = i + 1; r < n; r++) {
        if (a[r][i].abs() > a[p][i].abs()) p = r;
      }
      final ta = a[i];
      a[i] = a[p];
      a[p] = ta;
      final tb = b[i];
      b[i] = b[p];
      b[p] = tb;
      final d = a[i][i];
      if (d.abs() < 1e-12) continue;
      for (var r = i + 1; r < n; r++) {
        final f = a[r][i] / d;
        if (f == 0) continue;
        for (var c = i; c < n; c++) {
          a[r][c] -= f * a[i][c];
        }
        b[r] -= f * b[i];
      }
    }
    final x = List.filled(n, 0.0);
    for (var i = n - 1; i >= 0; i--) {
      var s = b[i];
      for (var c = i + 1; c < n; c++) {
        s -= a[i][c] * x[c];
      }
      x[i] = a[i][i].abs() < 1e-12 ? 0 : s / a[i][i];
    }
    return x;
  }
}
