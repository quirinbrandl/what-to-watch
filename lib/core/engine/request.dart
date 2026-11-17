import '../models.dart';

/// What the user asked for tonight.
class Request {
  String prompt;
  Set<int> genres; // every selected genre must be present
  Set<int> notGenres; // none of these may be present
  int? yearMin, yearMax;
  int? runMin, runMax; // minutes
  Set<String> langs; // original language, any of
  double obscurity; // 0 = familiar … 1 = obscure
  bool excludeWatched;
  bool personalize;
  bool streamingOnly; // only films on the user's services
  int? seedId; // "more like this"

  Request({
    this.prompt = '',
    Set<int>? genres,
    Set<int>? notGenres,
    this.yearMin,
    this.yearMax,
    this.runMin,
    this.runMax,
    Set<String>? langs,
    this.obscurity = 0.5,
    this.excludeWatched = true,
    this.personalize = true,
    this.streamingOnly = false,
    this.seedId,
  })  : genres = genres ?? {},
        notGenres = notGenres ?? {},
        langs = langs ?? {};

  bool get hasPrompt => prompt.trim().isNotEmpty;
  int get hardFilters =>
      (genres.isEmpty ? 0 : 1) +
      (notGenres.isEmpty ? 0 : 1) +
      (yearMin != null || yearMax != null ? 1 : 0) +
      (runMin != null || runMax != null ? 1 : 0) +
      (langs.isEmpty ? 0 : 1) +
      (streamingOnly ? 1 : 0);

  Request copy() => Request.fromJson(toJson());

  Map<String, dynamic> toJson() => {
        'prompt': prompt,
        'genres': genres.toList(),
        'notGenres': notGenres.toList(),
        'yearMin': yearMin,
        'yearMax': yearMax,
        'runMin': runMin,
        'runMax': runMax,
        'langs': langs.toList(),
        'obscurity': obscurity,
        'excludeWatched': excludeWatched,
        'personalize': personalize,
        'streamingOnly': streamingOnly,
        'seedId': seedId,
      };

  static Request fromJson(Map<String, dynamic> j) => Request(
        prompt: (j['prompt'] ?? '') as String,
        genres: {for (final g in (j['genres'] as List? ?? const [])) g as int},
        notGenres: {for (final g in (j['notGenres'] as List? ?? const [])) g as int},
        yearMin: j['yearMin'] as int?,
        yearMax: j['yearMax'] as int?,
        runMin: j['runMin'] as int?,
        runMax: j['runMax'] as int?,
        langs: {for (final g in (j['langs'] as List? ?? const [])) g as String},
        obscurity: (j['obscurity'] as num? ?? 0.5).toDouble(),
        excludeWatched: j['excludeWatched'] != false,
        personalize: j['personalize'] != false,
        streamingOnly: j['streamingOnly'] == true,
        seedId: j['seedId'] as int?,
      );
}

/// The user's region and streaming services.
class Services {
  final String region;
  final Map<int, String> mine; // provider id -> name
  const Services(this.region, [this.mine = const {}]);

  /// TMDB lists plan variants separately ("Netflix Standard with Ads"), so a
  /// provider also counts when its name starts with one of the user's.
  bool has(Prov p) {
    if (mine.containsKey(p.id)) return true;
    final n = p.name.toLowerCase();
    return mine.values.any((m) => n.startsWith(m.toLowerCase()));
  }

  List<Prov> available(Film f) => f.prov?.region == region ? [for (final p in f.prov!.streamable) if (has(p)) p] : const [];
}

/// The single place where hard constraints are enforced. Returns null when
/// the film may be recommended, otherwise the reason it may not.
///
/// With [listLevel] the film only carries list fields (no runtime/providers
/// yet); those checks are skipped and must be repeated on the full record.
/// Final picks always pass through here with `listLevel: false`.
String? rejectReason(Film f, Request r, Library lib, Services sv, {Set<int> shown = const {}, bool listLevel = false}) {
  if (f.adult) return 'adult';
  if (!f.released) return 'unreleased';
  if (f.id == r.seedId) return 'seed';
  if (shown.contains(f.id)) return 'shown';
  final e = lib[f.id];
  if (e != null) {
    if (e.notInterested) return 'not interested';
    if (r.excludeWatched && e.watched) return 'watched';
  }
  final y = f.year;
  if (r.yearMin != null && (y == null || y < r.yearMin!)) return 'year';
  if (r.yearMax != null && (y == null || y > r.yearMax!)) return 'year';
  if (!f.genres.toSet().containsAll(r.genres)) return 'genre';
  if (r.notGenres.any(f.genres.contains)) return 'genre';
  if (r.langs.isNotEmpty && !r.langs.contains(f.lang)) return 'language';
  if (f.poster == null) return 'no poster';
  if (f.votes < 15) return 'too few votes';
  if (listLevel) return null;
  if (!f.full) return 'no details';
  final rt = f.runtime ?? 0;
  if (r.runMin != null || r.runMax != null) {
    if (rt <= 0) return 'runtime';
    if (r.runMin != null && rt < r.runMin!) return 'runtime';
    if (r.runMax != null && rt > r.runMax!) return 'runtime';
  } else if (rt > 0 && rt < 40) {
    return 'short film';
  }
  if (r.streamingOnly && sv.available(f).isEmpty) return 'streaming';
  return null;
}
