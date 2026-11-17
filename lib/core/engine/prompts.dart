import '../models.dart';
import '../tmdb.dart';
import 'request.dart';
import 'taste.dart';

String _stars(double r) => r == r.roundToDouble() ? '${r.toInt()}★' : '$r★';

/// The user's taste evidence as compact text for the LLM.
class TasteBrief {
  final String text;
  final Map<String, int> tags; // "L12" -> TMDB id (only when tagged)
  const TasteBrief(this.text, this.tags);
}

/// [tagged] prefixes every rated film with a reference tag ([L12]) so the
/// judge can cite films in a way code can verify. [hide] omits films
/// (evaluation hold-out).
TasteBrief tasteBrief(Library lib, FilmCache films, TasteModel? model,
    {bool tagged = false, Set<int> hide = const {}, int maxRated = 320, bool listSeen = true}) {
  final sb = StringBuffer();
  final tags = <String, int>{};
  String name(int id) => films[id]?.label ?? '';
  var rated = [for (final e in lib.rated) if (!hide.contains(e.id) && films[e.id] != null) e];
  if (rated.length > maxRated) {
    // Keep every strong opinion, fill up with the most recent of the rest.
    final strong = rated.where((e) => e.rating! >= 4.5 || e.rating! <= 2.5 || e.favorite).toList();
    final rest = rated.where((e) => !strong.contains(e)).toList()..sort((a, b) => (b.ratingAt ?? 0).compareTo(a.ratingAt ?? 0));
    rated = [...strong, ...rest.take((maxRated - strong.length).clamp(0, rest.length))];
  }
  if (rated.isNotEmpty) {
    final mean = rated.map((e) => e.rating!).reduce((a, b) => a + b) / rated.length;
    sb.writeln('RATINGS by this user (0.5–5★, their average is ${mean.toStringAsFixed(1)}★, ♥ = also liked):');
    final groups = <double, List<Entry>>{};
    for (final e in rated) {
      groups.putIfAbsent(e.rating!, () => []).add(e);
    }
    var n = 0;
    for (final r in groups.keys.toList()..sort((a, b) => b.compareTo(a))) {
      final items = groups[r]!..sort((a, b) => (b.ratingAt ?? 0).compareTo(a.ratingAt ?? 0));
      sb.writeln('${_stars(r)}: ${items.map((e) {
        var s = name(e.id);
        if (tagged) {
          final tag = 'L${++n}';
          tags[tag] = e.id;
          s = '[$tag] $s';
        }
        return e.liked ? '$s ♥' : s;
      }).join('; ')}');
    }
  }
  List<String> names(Iterable<Entry> es, int max) {
    final l = es.where((e) => !hide.contains(e.id) && films[e.id] != null).toList();
    return [for (final e in l.take(max)) name(e.id)];
  }

  final fav = names(lib.entries.values.where((e) => e.favorite), 20);
  if (fav.isNotEmpty) sb.writeln('ALL-TIME FAVOURITES: ${fav.join('; ')}');
  final re = names(lib.entries.values.where((e) => e.rewatched && !e.favorite), 20);
  if (re.isNotEmpty) sb.writeln('REWATCHED: ${re.join('; ')}');
  final wl = lib.watchlist.toList()..sort((a, b) => (b.watchlistAt ?? 0).compareTo(a.watchlistAt ?? 0));
  final wln = names(wl, 60);
  if (wln.isNotEmpty) sb.writeln('WATCHLIST (unseen, wants to see): ${wln.join('; ')}');
  final ni = names(lib.entries.values.where((e) => e.notInterested), 40);
  if (ni.isNotEmpty) sb.writeln('NOT INTERESTED (dismissed): ${ni.join('; ')}');
  if (listSeen) {
    final seen = names(lib.entries.values.where((e) => e.watched && e.rating == null), 120);
    if (seen.isNotEmpty) sb.writeln('SEEN, UNRATED: ${seen.join('; ')}');
  }
  if (model != null && model.rated >= 12) {
    final parts = [
      if (model.top('g').isNotEmpty) 'rates above their average: ${model.top('g', n: 5).join(', ')}',
      if (model.top('g', positive: false).isNotEmpty) 'below their average: ${model.top('g', positive: false, n: 4).join(', ')}',
      if (model.top('d').isNotEmpty) 'directors: ${model.top('d', n: 6).join(', ')}',
      if (model.top('k').isNotEmpty) 'recurring themes in high ratings: ${model.top('k', n: 8).join(', ')}',
      if (model.top('k', positive: false).isNotEmpty) 'themes in low ratings: ${model.top('k', positive: false, n: 6).join(', ')}',
    ];
    if (parts.isNotEmpty) sb.writeln('PATTERNS (computed statistics, weaker evidence than the ratings): ${parts.join(' · ')}');
  }
  return TasteBrief(sb.toString().trim(), tags);
}

/// Tonight's request as text. Hard filters are stated so the LLM does not
/// waste picks, but they are enforced by code regardless.
String requestBrief(Request r, Services sv, {Film? seed}) {
  final sb = StringBuffer();
  if (seed != null) sb.writeln('MORE LIKE: ${seed.label} — films that give a similar experience, not just the same genre.');
  sb.writeln(r.hasPrompt ? 'REQUEST (in the user\'s words): "${r.prompt.trim()}"' : (seed == null ? 'REQUEST: none — a great film for tonight.' : ''));
  final hard = [
    if (r.genres.isNotEmpty) 'must be ${r.genres.map((g) => kGenres[g]).join(' AND ')}',
    if (r.notGenres.isNotEmpty) 'must not be ${r.notGenres.map((g) => kGenres[g]).join(' or ')}',
    if (r.yearMin != null || r.yearMax != null) 'released ${r.yearMin ?? '…'}–${r.yearMax ?? 'today'}',
    if (r.runMin != null || r.runMax != null) 'runtime ${r.runMin ?? 0}–${r.runMax ?? '∞'} min',
    if (r.langs.isNotEmpty) 'original language: ${r.langs.map((l) => kLanguages[l] ?? l).join(' or ')}',
    if (r.streamingOnly && sv.mine.isNotEmpty) 'must be streaming in ${sv.region} on: ${sv.mine.values.join(', ')}',
  ];
  if (hard.isNotEmpty) sb.writeln('HARD FILTERS: ${hard.join('; ')}.');
  final o = r.obscurity;
  sb.writeln('FAMILIAR↔OBSCURE: ${o < 0.2 ? 'well-known, widely loved films' : o < 0.4 ? 'lean towards well-known films' : o <= 0.6 ? 'balanced mix of known films and discoveries' : o <= 0.8 ? 'lean towards lesser-known films and discoveries' : 'deep cuts: films most people have not heard of'}.');
  if (!r.excludeWatched) sb.writeln('Rewatches are allowed: films the user has already seen may be suggested when they fit.');
  return sb.toString().trim();
}

const ideationSystem = '''
You are the scouting stage of a personal film recommender. You know cinema deeply: mainstream, arthouse, world cinema, classics and deep cuts.

Goal: propose feature films this specific user would rate 3★ or higher after watching — ideally 4★+ ("that was worth my evening"). Fit to their personal taste comes first, tonight's request second, everything else third.

How to work: study what separates their 4.5–5★ films from their ≤2.5★ films — tone, pacing, craft, themes, eras, directors, not just genres. Pick what a perceptive friend with exactly their taste would pick. Stay away from films that resemble what they rated low. Mix confident picks with a few well-reasoned stretches.

Rules:
- Real, released feature films only (no series, shorts, or unreleased films). Give the common English release title (or the original title) and the release year.
- Never propose a film listed under RATINGS, SEEN, NOT INTERESTED or ALREADY SUGGESTED (unless rewatches are allowed).
- Obey every HARD FILTER. Code verifies them against TMDB and discards violations.
- Follow the FAMILIAR↔OBSCURE preference.
- Watchlist films are allowed when they truly fit tonight, but at most a quarter of the picks.
- Spread the picks across directors, decades and countries unless the request narrows them.

Output one JSON object and nothing else:
{"seeds":[{"t":"title","y":1999}],"picks":[{"t":"title","y":1999}]}
"seeds": films the request text itself names as a reference point (empty list if none).
"picks": exactly the requested number of films, best first.''';

const ideationSystemGeneric = '''
You are the scouting stage of a film recommender. The user switched personalisation off, so ignore personal taste: propose excellent, widely admired feature films that fit tonight's request.

Rules:
- Real, released feature films only. Give the common English release title (or the original title) and the release year.
- Never propose a film listed under SEEN, NOT INTERESTED or ALREADY SUGGESTED (unless rewatches are allowed).
- Obey every HARD FILTER. Code verifies them against TMDB and discards violations.
- Follow the FAMILIAR↔OBSCURE preference. Spread picks across directors, decades and countries unless the request narrows them.

Output one JSON object and nothing else:
{"seeds":[{"t":"title","y":1999}],"picks":[{"t":"title","y":1999}]}
"seeds": films the request text itself names as a reference point (empty list if none).
"picks": exactly the requested number of films, best first.''';

String ideationUser(String taste, String request, int n, List<String> already) => [
      if (taste.isNotEmpty) taste,
      request,
      if (already.isNotEmpty) 'ALREADY SUGGESTED (do not repeat): ${already.join('; ')}',
      'Propose $n films.',
    ].join('\n\n');

const judgeSystem = '''
You are the judging stage of a personal film recommender. For every candidate, predict how THIS user would rate the film after watching it, and how well it fits tonight's request.

Use what you know about each film — tone, pacing, craft, reputation, how viewers with similar taste respond — together with the user's ratings. The metadata shown only identifies the film; your knowledge of it matters more. Be calibrated to this user: use their scale in 0.5 steps, and be honest about likely misses. A falsely high score wastes their evening; below 3★ counts as a miss.

Output JSON Lines — one line per candidate, in the given order, nothing else:
{"c":7,"r":4.0,"m":8,"why":"…"}

"r": predicted rating by this user, 0.5–5.
"m": 0–10, fit to tonight's request text and soft preferences (10 = exactly what was asked for, 5 = loosely related, 0 = contradicts it). Without request text, judge how good an evening pick it is for this user.
"why": at most 38 words, spoken to the user ("you"), concrete about why this film suits them and tonight's request: tone, craft, themes. Anchor it in their taste by referring to one or two films they rated 3.5★ or higher, using ONLY the tag form, e.g. "has the patient dread of [L12]" (the app prints the title). Never write the title of any film other than through a tag, never state star ratings, never invent facts about the user, and reveal nothing beyond the basic premise — no spoilers. If no honest anchor exists, describe the film's appeal for tonight without one.''';

const judgeSystemGeneric = '''
You are the judging stage of a film recommender. Personalisation is off. For every candidate, estimate how much a general film lover would enjoy it and how well it fits tonight's request.

Output JSON Lines — one line per candidate, in the given order, nothing else:
{"c":7,"r":4.0,"m":8,"why":"…"}

"r": expected enjoyment on a 0.5–5 star scale.
"m": 0–10, fit to tonight's request (10 = exactly what was asked for, 5 = loosely related, 0 = contradicts it).
"why": at most 38 words, spoken to the user ("you"), concrete about why this film suits tonight's request: tone, craft, themes. Never write the title of any other film, never invent facts about the user, and reveal nothing beyond the basic premise — no spoilers.''';

String candidateLine(int n, Film f) {
  final votes = f.votes >= 1000 ? '${(f.votes / 1000).toStringAsFixed(1)}k' : '${f.votes}';
  final ov = f.overview.length > 170 ? '${f.overview.substring(0, 170)}…' : f.overview;
  return [
    'C$n',
    f.label,
    if ((f.runtime ?? 0) > 0) '${f.runtime} min',
    f.genreNames.join(', '),
    if (f.lang != null && f.lang != 'en') kLanguages[f.lang] ?? f.lang!,
    if (f.directors.isNotEmpty) 'dir. ${f.directors.take(2).join(', ')}',
    if (f.cast.isNotEmpty) 'cast: ${f.cast.take(3).join(', ')}',
    if (f.keywords.isNotEmpty) 'themes: ${f.keywords.take(7).map((k) => k.name).join(', ')}',
    'TMDB ${f.vote.toStringAsFixed(1)} ($votes votes)',
    ov,
  ].join(' | ');
}

String judgeUser(String taste, String request, List<Film> candidates) => [
      if (taste.isNotEmpty) taste,
      request,
      'CANDIDATES:\n${[for (var i = 0; i < candidates.length; i++) candidateLine(i + 1, candidates[i])].join('\n')}',
    ].join('\n\n');

class Why {
  final String text;
  final List<int> refs; // library films the text refers to
  const Why(this.text, this.refs);
}

/// Checks an LLM-written "why" against the user's real data. Every film it
/// refers to must be a tagged library film the user rated ≥ 3.5★; star
/// claims are not allowed (the app shows real ratings itself). Returns null
/// when the text fails, in which case a deterministic explanation is used.
Why? validateWhy(String raw, Map<String, int> tags, Library lib, FilmCache films) {
  var text = raw.trim().replaceAll(RegExp(r'\s+'), ' ');
  if (text.length < 12 || text.length > 420) return null;
  if (RegExp(r'\d\s*(★|stars?\b|/\s*5|out of)').hasMatch(text) || text.contains('★')) return null;
  var bad = false;
  final refs = <int>[];
  text = text.replaceAllMapped(RegExp(r'\[\s*(L\d+)\s*\]|\b(L\d+)\b'), (m) {
    final id = tags[m[1] ?? m[2]];
    final e = id == null ? null : lib[id];
    final f = id == null ? null : films[id];
    if (e == null || f == null || (e.rating ?? 0) < 3.5) {
      bad = true;
      return '';
    }
    if (!refs.contains(id)) refs.add(id!);
    return f.title;
  });
  if (bad || text.contains('[') || text.contains(']')) return null;
  return Why(text, refs);
}
