import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import '../letterboxd.dart' show matchTitle;
import '../llm.dart';
import '../models.dart';
import '../tmdb.dart';
import 'prompts.dart';
import 'request.dart';
import 'taste.dart';

enum Stage { taste, scouting, checking, judging }

class Progress {
  final Stage stage;
  final int pool; // films under consideration
  final List<Film> posters; // newly discovered candidates (for the wait screen)
  const Progress(this.stage, this.pool, this.posters);
}

/// A library film that backs up an explanation, shown with the user's real rating.
class Anchor {
  final int id;
  final String title;
  final String? poster;
  final double? rating;
  const Anchor(this.id, this.title, this.poster, this.rating);
  Map<String, dynamic> toJson() => {'id': id, 't': title, 'p': poster, 'r': rating};
  static Anchor fromJson(Map<String, dynamic> j) =>
      Anchor(j['id'] as int, j['t'] as String, j['p'] as String?, (j['r'] as num?)?.toDouble());
}

class Pick {
  final Film film;
  final double predicted; // blended predicted stars for this user
  final double? judge; // LLM prediction
  final double local; // taste-model prediction
  final double match; // 0–10 fit to the request
  final double score; // ranking score
  final String why;
  final List<Anchor> anchors;
  final List<String> facts; // verifiable one-liners
  final bool personal;
  const Pick(this.film, this.predicted, this.judge, this.local, this.match, this.score, this.why, this.anchors, this.facts, this.personal);

  Map<String, dynamic> toJson() => {
        'id': film.id,
        'pred': predicted,
        'judge': judge,
        'local': local,
        'match': match,
        'score': score,
        'why': why,
        'anchors': [for (final a in anchors) a.toJson()],
        'facts': facts,
        'personal': personal,
      };

  static Pick? fromJson(Map<String, dynamic> j, FilmCache films) {
    final f = films[j['id'] as int];
    if (f == null) return null;
    return Pick(
      f,
      (j['pred'] as num).toDouble(),
      (j['judge'] as num?)?.toDouble(),
      (j['local'] as num).toDouble(),
      (j['match'] as num).toDouble(),
      (j['score'] as num).toDouble(),
      j['why'] as String,
      [for (final a in (j['anchors'] as List? ?? const [])) Anchor.fromJson((a as Map).cast<String, dynamic>())],
      [for (final a in (j['facts'] as List? ?? const [])) a as String],
      j['personal'] != false,
    );
  }
}

/// One discovery run: the request, what was shown, and judged films held in
/// reserve for "more".
class Session {
  final Request request;
  final List<Pick> picks = [];
  final List<Pick> reserve = [];
  final Set<int> seen = {}; // judged or rejected in this session
  final List<String> suggested = []; // titles the LLM proposed so far
  String? notice; // non-fatal problem worth telling the user
  int rounds = 0;
  bool exhausted = false;
  Session(this.request);

  Map<String, dynamic> toJson() => {
        'request': request.toJson(),
        'picks': [for (final p in picks) p.toJson()],
        'reserve': [for (final p in reserve) p.toJson()],
        'seen': seen.toList(),
        'suggested': suggested,
        'rounds': rounds,
      };

  static Session fromJson(Map<String, dynamic> j, FilmCache films) {
    final s = Session(Request.fromJson((j['request'] as Map).cast<String, dynamic>()));
    List<Pick> l(String k) => [
          for (final p in (j[k] as List? ?? const []))
            if (Pick.fromJson((p as Map).cast<String, dynamic>(), films) case final Pick x) x
        ];
    s.picks.addAll(l('picks'));
    s.reserve.addAll(l('reserve'));
    s.seen.addAll([for (final i in (j['seen'] as List? ?? const [])) i as int]);
    s.suggested.addAll([for (final i in (j['suggested'] as List? ?? const [])) i as String]);
    s.rounds = j['rounds'] as int? ?? 1;
    return s;
  }
}

class JudgeResult {
  final double r, m;
  final String why;
  const JudgeResult(this.r, this.m, this.why);
}

class EngineConfig {
  String model;
  String? ideateEffort, judgeEffort;
  int batch, judgeMax;
  double judgeWeight; // share of the LLM in the blended prediction
  EngineConfig(this.model, {this.ideateEffort = 'low', this.judgeEffort = 'medium', this.batch = 8, this.judgeMax = 36, this.judgeWeight = 0.6});
}

class _Cand {
  final int id;
  Film? film;
  double graph = 0;
  bool llm = false, seed = false;
  int rank = 1 << 20;
  double quick = 0, local = 0;
  Prediction? pred;
  _Cand(this.id);
}

typedef Idea = (String title, int? year);

/// The recommendation pipeline: retrieve wide → enforce in code → judge with
/// the LLM → blend with the local taste model → diversify.
class Recommender {
  final Tmdb tmdb;
  final Llm llm;
  final Library lib;
  Services sv;
  EngineConfig cfg;
  TasteModel? _model;
  int _rev = -1;

  Recommender(this.tmdb, this.llm, this.lib, this.sv, this.cfg);

  FilmCache get films => tmdb.cache;

  TasteModel model() {
    if (_model == null || _rev != lib.rev) {
      _model = TasteModel.fromLibrary(lib, films);
      _rev = lib.rev;
    }
    return _model!;
  }

  /// Taste modelling needs full TMDB records for every library film.
  Future<void> ensureLibraryDetails({void Function(int done, int total)? onProgress}) async {
    final missing = [for (final id in lib.entries.keys) if (films[id]?.full != true) id];
    if (missing.isEmpty) return;
    var done = 0;
    await tmdb.detailsAll(missing, sv.region, providerMaxAgeDays: 36500, onEach: (_) => onProgress?.call(++done, missing.length));
    _rev = -1;
  }

  Future<Session> start(Request r, {void Function(Progress)? onProgress}) async {
    final s = Session(r.copy());
    await more(s, onProgress: onProgress);
    return s;
  }

  /// Appends the next batch to `s.picks`; returns how many were added.
  Future<int> more(Session s, {void Function(Progress)? onProgress}) async {
    final good = s.reserve.where((p) => p.predicted >= 3.5).length;
    if (good < cfg.batch && !s.exhausted && s.rounds < 8) {
      final before = s.seen.length;
      await _round(s, onProgress ?? (_) {});
      if (s.seen.length == before) s.exhausted = true;
    }
    final batch = _take(s, cfg.batch);
    s.picks.addAll(batch);
    return batch.length;
  }

  // ------------------------------------------------------------ LLM stages

  Future<({List<Idea> picks, List<Idea> seeds})> ideate(Request r, TasteModel? m, {Film? seed, List<String> already = const [], int? n}) async {
    final count = n ?? ((r.streamingOnly || r.hardFilters >= 3) ? 60 : 40);
    final String taste;
    if (m != null) {
      taste = tasteBrief(lib, films, m).text;
    } else {
      final seen = [for (final e in lib.entries.values) if ((e.watched || e.notInterested) && films[e.id] != null) films[e.id]!.label];
      taste = seen.isEmpty ? '' : 'SEEN OR NOT INTERESTED: ${seen.take(400).join('; ')}';
    }
    final text = await llm.respond(
      model: cfg.model,
      developer: m != null ? ideationSystem : ideationSystemGeneric,
      user: ideationUser(taste, requestBrief(r, sv, seed: seed), count, already),
      effort: cfg.ideateEffort,
    );
    final j = extractJson(text);
    if (j == null) throw LlmException('bad_output', 'ideation output was not JSON');
    List<Idea> list(String k) => [
          for (final p in (j[k] as List? ?? const []))
            if (p is Map && p['t'] is String && (p['t'] as String).trim().isNotEmpty)
              ((p['t'] as String).trim(), p['y'] is num ? (p['y'] as num).toInt() : int.tryParse('${p['y']}'))
        ];
    return (picks: list('picks'), seeds: list('seeds'));
  }

  /// Predicted rating, request fit and explanation for each candidate.
  Future<Map<int, JudgeResult>> judge(List<Film> cands, {TasteBrief? brief, required String request}) async {
    final text = await llm.respond(
      model: cfg.model,
      developer: brief == null ? judgeSystemGeneric : judgeSystem,
      user: judgeUser(brief?.text ?? '', request, cands),
      effort: cfg.judgeEffort,
    );
    var rows = extractJsonLines(text);
    if (rows.length < cands.length ~/ 2) {
      rows = [
        for (final m in RegExp(r'\{[^{}]*\}').allMatches(text))
          if (_tryMap(m[0]!) case final Map<String, dynamic> x) x
      ];
    }
    final out = <int, JudgeResult>{};
    for (final j in rows) {
      final c = j['c'] is num ? (j['c'] as num).toInt() : int.tryParse('${j['c']}'.replaceAll(RegExp(r'\D'), ''));
      final r = j['r'];
      if (c == null || c < 1 || c > cands.length || r is! num) continue;
      out[cands[c - 1].id] = JudgeResult(
          r.toDouble().clamp(0.5, 5.0).toDouble(), ((j['m'] as num?) ?? 6).toDouble().clamp(0.0, 10.0).toDouble(), '${j['why'] ?? ''}');
    }
    return out;
  }

  static Map<String, dynamic>? _tryMap(String s) {
    try {
      return (jsonDecode(s) as Map).cast<String, dynamic>();
    } catch (_) {
      return null;
    }
  }

  // ------------------------------------------------------------ one round

  Future<void> _round(Session s, void Function(Progress) emit) async {
    final r = s.request;
    s.rounds++;
    s.notice = null;
    emit(const Progress(Stage.taste, 0, []));
    await ensureLibraryDetails();
    final m = r.personalize && lib.entries.isNotEmpty ? model() : null;
    Film? seed;
    if (r.seedId != null) seed = await tmdb.details(r.seedId!, sv.region);
    final shown = {...s.seen, for (final p in s.picks) p.film.id, for (final p in s.reserve) p.film.id};

    final cands = <int, _Cand>{};
    _Cand c(int id) => cands.putIfAbsent(id, () => _Cand(id));
    final postered = <int>{};
    void show(Stage st, Iterable<Film?> fs) => emit(Progress(st, cands.length, [
          for (final f in fs)
            if (f != null && f.poster != null && !shown.contains(f.id) && lib[f.id]?.watched != true && postered.add(f.id)) f
        ]));

    // 1) LLM scouting runs while TMDB retrieval happens.
    final ideasF = ideate(r, m, seed: seed, already: [...s.suggested, for (final p in s.picks) p.film.label]);
    unawaited(ideasF.then((_) {}, onError: (_) {}));

    // 2) TMDB's recommendation graph around the films the user loves most.
    if (m != null) {
      final anchors = m.samples.where((x) => x.rated && x.y >= math.max(4.0, m.mean + 0.25)).toList()
        ..sort((a, b) => (b.y * b.w).compareTo(a.y * a.w));
      for (final a in anchors.take(24)) {
        for (final id in a.film.recs) {
          c(id).graph += a.w * (a.y - m.mean);
        }
      }
    }
    if (seed != null) {
      final rel = await Future.wait([
        tmdb.similar(seed.id).catchError((_) => <Film>[]),
        tmdb.recommendations(seed.id, page: 2).catchError((_) => <Film>[]),
      ]);
      for (final id in [...seed.recs, for (final l in rel) ...l.map((f) => f.id)]) {
        c(id).seed = true;
      }
    }
    show(Stage.scouting, cands.keys.map((id) => films[id]));

    // 3) TMDB discover with the request's filters.
    final found = await Future.wait(_discover(r, m).map((f) => f.catchError((_) => <Film>[])));
    for (final l in found) {
      for (final f in l) {
        c(f.id);
      }
      show(Stage.scouting, l);
    }

    // 4) Resolve the LLM's ideas to real TMDB films; anything unknown is dropped.
    var ideas = (picks: <Idea>[], seeds: <Idea>[]);
    try {
      ideas = await ideasF;
    } on LlmException catch (e) {
      if (e.needsSignIn) rethrow;
      s.notice = e.friendly;
    }
    final resolved = await Future.wait(ideas.picks.map((p) => matchTitle(tmdb, p.$1, p.$2).catchError((_) => null)));
    for (var i = 0; i < resolved.length; i++) {
      final f = resolved[i];
      if (f == null) continue;
      final x = c(f.id)..llm = true;
      x.rank = math.min(x.rank, i);
    }
    s.suggested.addAll(ideas.picks.map((p) => p.$2 == null ? p.$1 : '${p.$1} (${p.$2})'));
    show(Stage.scouting, resolved);
    // Films the request itself names ("like Past Lives"): add their neighbourhood.
    for (final sd in ideas.seeds.take(3)) {
      try {
        final f = await matchTitle(tmdb, sd.$1, sd.$2);
        if (f == null) continue;
        for (final id in (await tmdb.details(f.id, sv.region)).recs) {
          c(id).seed = true;
        }
      } catch (_) {}
    }

    // 5) Screen on list-level data, then fetch details for the most promising.
    final screened = <_Cand>[];
    for (final x in cands.values) {
      final f = films[x.id];
      if (f != null) {
        if (rejectReason(f, r, lib, sv, shown: shown, listLevel: true) != null) continue;
        x.quick = _quick(f, x, m, r);
      } else {
        if (shown.contains(x.id) || lib[x.id]?.notInterested == true || (r.excludeWatched && lib[x.id]?.watched == true)) continue;
        x.quick = 3.0 + (x.seed ? 0.6 : 0);
      }
      screened.add(x);
    }
    final viaLlm = screened.where((x) => x.llm).toList()..sort((a, b) => a.rank.compareTo(b.rank));
    final rest = screened.where((x) => !x.llm).toList()..sort((a, b) => b.quick.compareTo(a.quick));
    final toDetail = [...viaLlm.take(60), ...rest.take(math.max(30, 90 - viaLlm.length))];
    emit(Progress(Stage.checking, toDetail.length, const []));
    await tmdb.detailsAll(toDetail.map((x) => x.id), sv.region, onEach: (f) => show(Stage.checking, [f]));

    // 6) Hard filters on full records. Nothing gets past this point otherwise.
    final ok = <_Cand>[];
    for (final x in toDetail) {
      final f = films[x.id];
      if (f == null || !f.full || rejectReason(f, r, lib, sv, shown: shown) != null) {
        s.seen.add(x.id);
        continue;
      }
      x.film = f;
      x.pred = m?.predict(f);
      x.local = x.pred?.rating ?? _generic(f);
      x.quick = x.local + _bonus(x, f, r);
      ok.add(x);
    }

    // 7) The LLM judges the best ~36: its own ideas plus the strongest others.
    final okLlm = ok.where((x) => x.llm).toList()..sort((a, b) => a.rank.compareTo(b.rank));
    final okRest = ok.where((x) => !x.llm).toList()..sort((a, b) => b.quick.compareTo(a.quick));
    final nLlm = math.min(okLlm.length, math.max((cfg.judgeMax * 0.7).round(), cfg.judgeMax - okRest.length));
    final toJudge = [...okLlm.take(nLlm), ...okRest.take(cfg.judgeMax - nLlm)];
    emit(Progress(Stage.judging, toJudge.length, const []));
    final brief = m != null ? tasteBrief(lib, films, m, tagged: true, listSeen: false) : null;
    var verdicts = <int, JudgeResult>{};
    if (toJudge.isNotEmpty) {
      try {
        verdicts = await judge([for (final x in toJudge) x.film!], brief: brief, request: requestBrief(r, sv, seed: seed));
      } on LlmException catch (e) {
        if (e.needsSignIn) rethrow;
        s.notice = e.friendly;
      }
    }

    // 8) Blend, explain, keep.
    for (final x in toJudge) {
      s.seen.add(x.id);
      final p = _pick(x, verdicts[x.id], brief, r, seed != null);
      if (p != null) s.reserve.add(p);
    }
    s.reserve.sort((a, b) => b.score.compareTo(a.score));
  }

  List<Future<List<Film>>> _discover(Request r, TasteModel? m) {
    final today = DateTime.now().toIso8601String().substring(0, 10);
    final base = <String, String>{
      if (r.genres.isNotEmpty) 'with_genres': r.genres.join(','),
      if (r.notGenres.isNotEmpty) 'without_genres': r.notGenres.join(','),
      if (r.yearMin != null) 'primary_release_date.gte': '${r.yearMin}-01-01',
      'primary_release_date.lte': r.yearMax != null && '${r.yearMax}-12-31'.compareTo(today) < 0 ? '${r.yearMax}-12-31' : today,
      'with_runtime.gte': '${r.runMin ?? 40}',
      if (r.runMax != null) 'with_runtime.lte': '${r.runMax}',
      if (r.langs.length == 1) 'with_original_language': r.langs.first,
      if (r.streamingOnly && sv.mine.isNotEmpty) ...{
        'watch_region': sv.region,
        'with_watch_providers': sv.mine.keys.join('|'),
        'with_watch_monetization_types': 'flatrate|free|ads',
      },
    };
    final o = r.obscurity;
    final floor = o < 0.33 ? 2000 : (o <= 0.66 ? 200 : 40);
    final quality = {...base, 'sort_by': 'vote_average.desc', 'vote_count.gte': '$floor', if (o > 0.66) 'vote_count.lte': '3000'};
    final out = [tmdb.discover(quality), tmdb.discover(quality, page: 2)];
    if (o <= 0.66) out.add(tmdb.discover({...base, 'sort_by': 'popularity.desc', 'vote_count.gte': '$floor', 'vote_average.gte': '6.5'}));
    if (r.hardFilters > 0) out.add(tmdb.discover(quality, page: 3));
    final kws = m?.topKeywordIds() ?? const <int>[];
    if (kws.isNotEmpty) {
      out.add(tmdb.discover(
          {...base, 'with_keywords': kws.join('|'), 'sort_by': 'vote_average.desc', 'vote_count.gte': '${math.max(60, floor ~/ 3)}'}));
    }
    if (r.langs.length > 1) {
      for (final l in r.langs.take(4)) {
        out.add(tmdb.discover({...quality, 'with_original_language': l}));
      }
    }
    return out;
  }

  static double _generic(Film f) => (3.3 + 0.55 * (f.score - 6.3)).clamp(1.0, 5.0).toDouble();

  /// Familiar ↔ obscure preference as a soft score adjustment.
  static double _dial(Film f, double o) {
    final w = (o - 0.5).abs() * 2;
    if (w < 0.1) return 0;
    final lv = math.log(f.votes + 1) / math.ln10;
    final d = o < 0.5 ? math.max(0.0, 4.2 - lv) : math.max(0.0, lv - 2.4);
    return -0.45 * w * d;
  }

  double _bonus(_Cand x, Film f, Request r) =>
      0.35 * _tanh(x.graph / 2) + (x.seed ? 0.6 : 0) + _dial(f, r.obscurity) + (lib[f.id]?.watchlist == true ? 0.15 : 0);

  double _quick(Film f, _Cand x, TasteModel? m, Request r) => (m?.predict(f).rating ?? _generic(f)) + _bonus(x, f, r);

  static double _tanh(double v) {
    final e = math.exp(2 * v);
    return (e - 1) / (e + 1);
  }

  Pick? _pick(_Cand x, JudgeResult? j, TasteBrief? brief, Request r, bool seeded) {
    final f = x.film!;
    final needMatch = r.hasPrompt || seeded;
    final match = j?.m ?? (x.llm || x.seed ? 7.0 : 6.0);
    if (j != null && j.r < 3.0) return null; // the judge expects a miss
    if (needMatch && j != null && match < 5) return null; // does not honour the request
    final predicted = j == null ? x.local : cfg.judgeWeight * j.r + (1 - cfg.judgeWeight) * x.local;
    final e = lib[f.id];
    final score = predicted + (needMatch ? 0.22 : 0.08) * (match - 7) + _dial(f, r.obscurity) + (e?.watchlist == true ? 0.15 : 0);

    final why = j == null ? null : validateWhy(j.why, brief?.tags ?? const {}, lib, films);
    Anchor anchor(int id) => Anchor(id, films[id]!.title, films[id]!.poster, lib[id]?.rating);
    var anchors = [for (final id in why?.refs ?? const <int>[]) anchor(id)];
    if (anchors.isEmpty && x.pred != null) {
      anchors = [for (final n in x.pred!.neighbors.where((n) => n.rating >= 4 && n.sim >= 0.18).take(2)) anchor(n.film.id)];
    }
    final facts = _facts(f);
    var text = why?.text;
    if (text == null) {
      if (anchors.isNotEmpty) {
        text = 'Has a lot in common with ${anchors.map((a) => a.title).join(' and ')}, which you rated highly.';
      } else {
        text = 'A well-regarded ${f.genreNames.take(2).join(' / ').toLowerCase()} film: TMDB users give it ${f.vote.toStringAsFixed(1)}.';
      }
    }
    return Pick(f, predicted.clamp(0.5, 5.0).toDouble(), j?.r, x.local, match, score, text, anchors, facts, brief != null);
  }

  /// Short, verifiable facts linking a film to the user's library.
  List<String> _facts(Film f) {
    final out = <String>[];
    final e = lib[f.id];
    if (e?.watchlist == true) out.add('On your watchlist');
    Entry? best(bool Function(Film) test) {
      Entry? b;
      for (final en in lib.rated) {
        final lf = films[en.id];
        if (lf == null || lf.id == f.id || en.rating! < 4 || !test(lf)) continue;
        if (b == null || en.rating! > b.rating!) b = en;
      }
      return b;
    }

    for (final d in f.directors.take(1)) {
      final b = best((lf) => lf.directors.contains(d));
      if (b != null) out.add('From $d, director of ${films[b.id]!.title}');
    }
    if (out.length < 2) {
      for (final a in f.cast.take(2)) {
        final b = best((lf) => lf.cast.take(4).contains(a));
        if (b != null) {
          out.add('With $a from ${films[b.id]!.title}');
          break;
        }
      }
    }
    return out;
  }

  /// Picks the next batch from the reserve, best first, but spread out:
  /// a second film by the same director or a near-twin is pushed back.
  List<Pick> _take(Session s, int n) {
    final out = <Pick>[];
    while (out.length < n && s.reserve.isNotEmpty) {
      Pick? best;
      var bestScore = double.negativeInfinity;
      for (final p in s.reserve) {
        var sc = p.score;
        for (final q in out) {
          if (p.film.directors.any(q.film.directors.contains)) sc -= 0.5;
          if (p.film.genres.where(q.film.genres.contains).length >= 2 && p.film.decade == q.film.decade) sc -= 0.12;
        }
        if (sc > bestScore) {
          bestScore = sc;
          best = p;
        }
      }
      s.reserve.remove(best);
      out.add(best!);
    }
    return out;
  }
}
