import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:http/http.dart' as http;
import 'package:xml/xml.dart';

import 'models.dart';
import 'tmdb.dart';

// ---------------------------------------------------------------- CSV

/// RFC 4180 CSV parser (quoted fields, escaped quotes, embedded newlines).
List<List<String>> parseCsv(String s) {
  final rows = <List<String>>[];
  var row = <String>[];
  final sb = StringBuffer();
  var quoted = false;
  for (var i = 0; i < s.length; i++) {
    final c = s[i];
    if (quoted) {
      if (c == '"') {
        if (i + 1 < s.length && s[i + 1] == '"') {
          sb.write('"');
          i++;
        } else {
          quoted = false;
        }
      } else {
        sb.write(c);
      }
    } else if (c == '"') {
      quoted = true;
    } else if (c == ',') {
      row.add(sb.toString());
      sb.clear();
    } else if (c == '\n' || c == '\r') {
      if (c == '\r' && i + 1 < s.length && s[i + 1] == '\n') i++;
      row.add(sb.toString());
      sb.clear();
      rows.add(row);
      row = [];
    } else {
      sb.write(c);
    }
  }
  if (sb.isNotEmpty || row.isNotEmpty) {
    row.add(sb.toString());
    rows.add(row);
  }
  return rows;
}

List<Map<String, String>> csvMaps(List<List<String>> rows) {
  if (rows.isEmpty) return const [];
  final head = [for (final h in rows.first) h.trim().replaceAll('﻿', '')];
  return [
    for (final r in rows.skip(1))
      if (r.any((c) => c.isNotEmpty)) {for (var i = 0; i < head.length && i < r.length; i++) head[i]: r[i]}
  ];
}

int? _dateSec(String? d) {
  if (d == null || d.length < 10) return null;
  final t = DateTime.tryParse('${d.substring(0, 10)}T00:00:00Z');
  return t == null ? null : t.millisecondsSinceEpoch ~/ 1000;
}

// ---------------------------------------------------------------- export ZIP

class LbFilm {
  final String name;
  final int? year;
  String? uri;
  double? rating;
  int? ratingAt;
  bool watched = false;
  int? watchedAt;
  bool watchlist = false;
  int? watchlistAt;
  bool liked = false;
  bool favorite = false;
  bool rewatch = false;
  final Set<String> watchDates = {};
  int? tmdbId;
  LbFilm(this.name, this.year);
  String get key => '${name.toLowerCase()}|${year ?? ''}';
}

class LbExport {
  String? username;
  int? exportAt;
  final Map<String, LbFilm> films = {}; // by name|year
  int get ratings => films.values.where((f) => f.rating != null).length;
  int get watched => films.values.where((f) => f.watched).length;
  int get watchlist => films.values.where((f) => f.watchlist).length;
}

class LbFormatException implements Exception {
  final String message;
  LbFormatException(this.message);
  @override
  String toString() => message;
}

/// Reads a complete Letterboxd export ZIP. The user never picks single CSVs:
/// every known file is located by name, wherever it sits inside the archive.
LbExport parseLetterboxdZip(Uint8List bytes) {
  final Archive zip;
  try {
    zip = ZipDecoder().decodeBytes(bytes);
  } catch (_) {
    throw LbFormatException('That file is not a ZIP archive.');
  }
  final files = <String, String>{};
  for (final f in zip.files) {
    if (!f.isFile || !f.name.toLowerCase().endsWith('.csv')) continue;
    final parts = f.name.replaceAll('\\', '/').split('/').where((p) => p.isNotEmpty).toList();
    if (parts.any((p) => p.startsWith('__MACOSX') || p.startsWith('._'))) continue;
    final base = parts.last.toLowerCase();
    final parent = parts.length > 1 ? parts[parts.length - 2].toLowerCase() : '';
    final rel = const {'likes', 'lists', 'deleted', 'orphaned'}.contains(parent) ? '$parent/$base' : base;
    files[rel] = utf8.decode(f.content, allowMalformed: true);
  }
  return parseLetterboxdFiles(files);
}

/// [files] maps a relative path such as `ratings.csv` or `likes/films.csv`
/// to its text content.
LbExport parseLetterboxdFiles(Map<String, String> files) {
  if (!files.containsKey('ratings.csv') && !files.containsKey('watched.csv') && !files.containsKey('watchlist.csv')) {
    throw LbFormatException('This ZIP does not look like a Letterboxd export.');
  }
  final ex = LbExport();
  final byUri = <String, LbFilm>{};
  var maxDate = 0;

  List<Map<String, String>> rows(String name) => files[name] == null ? const [] : csvMaps(parseCsv(files[name]!));

  LbFilm? film(Map<String, String> r, {bool uriIsFilm = true}) {
    final name = (r['Name'] ?? '').trim();
    if (name.isEmpty) return null;
    final year = int.tryParse((r['Year'] ?? '').trim());
    final f = ex.films.putIfAbsent('${name.toLowerCase()}|${year ?? ''}', () => LbFilm(name, year));
    final uri = r['Letterboxd URI'] ?? r['URL'];
    if (uriIsFilm && uri != null && uri.isNotEmpty) {
      f.uri ??= uri;
      byUri[uri] = f;
    }
    final d = _dateSec(r['Date']);
    if (d != null && d > maxDate) maxDate = d;
    return f;
  }

  for (final r in rows('watched.csv')) {
    final f = film(r);
    if (f == null) continue;
    f.watched = true;
    f.watchedAt = _dateSec(r['Date']);
  }
  for (final r in rows('ratings.csv')) {
    final f = film(r);
    final rating = double.tryParse(r['Rating'] ?? '');
    if (f == null || rating == null) continue;
    f.rating = rating;
    f.ratingAt = _dateSec(r['Date']);
    f.watched = true;
    f.watchedAt ??= f.ratingAt;
  }
  for (final r in rows('watchlist.csv')) {
    final f = film(r);
    if (f == null) continue;
    f.watchlist = true;
    f.watchlistAt = _dateSec(r['Date']);
  }
  // Diary and review rows carry the URI of the *entry*, not of the film.
  for (final name in ['diary.csv', 'reviews.csv']) {
    for (final r in rows(name)) {
      final f = film(r, uriIsFilm: false);
      if (f == null) continue;
      f.watched = true;
      final wd = (r['Watched Date'] ?? '').trim();
      if (wd.length >= 10) f.watchDates.add(wd.substring(0, 10));
      if ((r['Rewatch'] ?? '').trim().toLowerCase() == 'yes') f.rewatch = true;
      final when = _dateSec(wd.isEmpty ? r['Date'] : wd) ?? _dateSec(r['Date']);
      if (when != null && (f.watchedAt == null || when > f.watchedAt!)) f.watchedAt = when;
      // A diary rating only fills in when ratings.csv has none for this film.
      final rating = double.tryParse(r['Rating'] ?? '');
      if (rating != null && f.rating == null) {
        f.rating = rating;
        f.ratingAt = _dateSec(r['Date']);
      }
    }
  }
  for (final r in rows('likes/films.csv')) {
    film(r)?.liked = true;
  }
  // Lists that read like favourites ("Top 10", "Favorites", ...) count as favourites.
  for (final e in files.entries.where((e) => e.key.startsWith('lists/'))) {
    final all = parseCsv(e.value);
    final head = all.indexWhere((r) => r.isNotEmpty && r.first.trim() == 'Position');
    if (head < 0) continue;
    final listName = (head >= 2 && all[head - 2].length > 1 ? all[head - 2][1] : e.key).toLowerCase();
    final fav = RegExp(r'top|fav|best|loved|all[- ]?time|greatest').hasMatch(listName) &&
        !RegExp(r'worst|hate|bad|disappoint|watchlist|to watch').hasMatch(listName);
    if (!fav) continue;
    for (final r in csvMaps(all.sublist(head))) {
      film(r)?.favorite = true;
    }
  }
  for (final r in rows('profile.csv')) {
    final u = (r['Username'] ?? '').trim();
    if (u.isNotEmpty) ex.username = u;
    for (final uri in (r['Favorite Films'] ?? '').split(',')) {
      byUri[uri.trim()]?.favorite = true;
    }
    final d = _dateSec(r['Date Joined']);
    if (d != null && d > maxDate) maxDate = d;
  }
  ex.exportAt = maxDate == 0 ? null : maxDate + 86399;
  return ex;
}

// ---------------------------------------------------------------- TMDB matching

const _fold = {
  'à': 'a', 'á': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a', 'å': 'a', 'æ': 'ae', 'ç': 'c', 'è': 'e', 'é': 'e', 'ê': 'e', 'ë': 'e',
  'ì': 'i', 'í': 'i', 'î': 'i', 'ï': 'i', 'ñ': 'n', 'ò': 'o', 'ó': 'o', 'ô': 'o', 'õ': 'o', 'ö': 'o', 'ø': 'o', 'œ': 'oe',
  'ù': 'u', 'ú': 'u', 'û': 'u', 'ü': 'u', 'ý': 'y', 'ÿ': 'y', 'ß': 'ss', 'ł': 'l', 'ś': 's', 'š': 's', 'ž': 'z', 'ż': 'z',
  'č': 'c', 'ć': 'c', 'ř': 'r', 'ě': 'e', 'ő': 'o', 'ű': 'u', 'ğ': 'g', 'ı': 'i', 'ş': 's', 'đ': 'd', 'ā': 'a', 'ō': 'o', 'ū': 'u',
}; // dart format off

String normTitle(String s) {
  final sb = StringBuffer();
  for (final r in s.toLowerCase().replaceAll('&', 'and').runes) {
    final c = String.fromCharCode(r);
    final f = _fold[c] ?? c;
    for (final u in f.codeUnits) {
      if ((u >= 97 && u <= 122) || (u >= 48 && u <= 57) || u > 0x2ff) sb.writeCharCode(u);
    }
  }
  return sb.toString();
}

double _dice(String a, String b) {
  if (a == b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  final ga = <String, int>{};
  for (var i = 0; i < a.length - 1; i++) {
    ga.update(a.substring(i, i + 2), (v) => v + 1, ifAbsent: () => 1);
  }
  var hit = 0;
  for (var i = 0; i < b.length - 1; i++) {
    final g = b.substring(i, i + 2);
    final n = ga[g] ?? 0;
    if (n > 0) {
      hit++;
      ga[g] = n - 1;
    }
  }
  return 2 * hit / (a.length + b.length - 2);
}

/// How well a TMDB film matches a title/year pair. ≥ 100 is a confident match.
double matchScore(Film f, String title, int? year, {bool yearHit = false}) {
  final n = normTitle(title);
  final exact = normTitle(f.title) == n || (f.original != null && normTitle(f.original!) == n);
  // "Glass Onion" vs "Glass Onion: A Knives Out Mystery": main titles agree.
  String main_(String t) => normTitle(t.split(RegExp(r':| - | – ')).first);
  final sub = !exact && n.length >= 4 && f.votes >= 100 && (main_(f.title) == n || normTitle(f.title) == main_(title));
  var s = exact
      ? 100.0
      : (sub ? 90.0 : 60 * math.max(_dice(normTitle(f.title), n), f.original == null ? 0 : _dice(normTitle(f.original!), n)));
  if (year != null) {
    if (f.year == null) {
      s -= 20;
    } else {
      final d = (f.year! - year).abs();
      // [yearHit]: TMDB's year-filtered search returned it, so it has *a*
      // release in that year even if its primary date moved (re-releases).
      s += d == 0 ? 40 : (d == 1 || (yearHit && exact) ? 25 : (d == 2 ? 0 : -40));
    }
  }
  return s + math.min(16, math.log(f.votes + 1) / math.ln10 * 4);
}

/// Finds the TMDB film for a title/year. Returns null when nothing matches
/// with confidence, rather than guessing.
Future<Film?> matchTitle(Tmdb tmdb, String title, int? year) async {
  Film? best;
  var bestScore = 0.0;
  void consider(List<Film> l, {bool yearHit = false}) {
    for (final f in l.take(10)) {
      final s = matchScore(f, title, year, yearHit: yearHit);
      if (s > bestScore) {
        bestScore = s;
        best = f;
      }
    }
  }

  consider(await tmdb.search(title, year: year), yearHit: year != null);
  if (bestScore < 125 && year != null) consider(await tmdb.search(title));
  return bestScore >= 100 ? best : null;
}

/// Resolves every film of an export to a TMDB id.
Future<void> matchExport(LbExport ex, Tmdb tmdb, {void Function(int done, int total, Film? film)? onProgress}) async {
  final list = ex.films.values.toList();
  var done = 0;
  await Future.wait(list.map((f) async {
    Film? m;
    try {
      m = await matchTitle(tmdb, f.name, f.year);
    } catch (_) {}
    f.tmdbId = m?.id;
    onProgress?.call(++done, list.length, m);
  }));
}

/// A ZIP export is a full snapshot of the Letterboxd side: replace all
/// Letterboxd-derived values, keep everything done in the app.
void applyExport(Library lib, LbExport ex) {
  for (final e in lib.entries.values) {
    e.clearLetterboxd();
  }
  lib.unmatched = [];
  for (final f in ex.films.values) {
    final id = f.tmdbId;
    if (id == null) {
      lib.unmatched.add(f.year == null ? f.name : '${f.name} (${f.year})');
      continue;
    }
    final e = lib.entry(id);
    if (f.rating != null && (e.lbRatingAt == null || (f.ratingAt ?? 0) >= e.lbRatingAt!)) {
      e.lbRating = f.rating;
      e.lbRatingAt = f.ratingAt ?? 0;
      e.lbSrcAt = f.ratingAt ?? 0;
    }
    if (f.watched) {
      e.lbWatched = true;
      if (f.watchedAt != null && (e.lbWatchedAt == null || f.watchedAt! > e.lbWatchedAt!)) e.lbWatchedAt = f.watchedAt;
    }
    if (f.watchlist) {
      e.lbWatchlist = true;
      e.lbWatchlistAt = f.watchlistAt ?? 0;
    }
    e.lbLiked = e.lbLiked || f.liked;
    e.favorite = e.favorite || f.favorite;
    e.lbRewatch = e.lbRewatch || f.rewatch;
    for (final d in f.watchDates) {
      if (!e.watchDates.contains(d)) e.watchDates.add(d);
    }
  }
  if (ex.username != null) lib.lbUsername = ex.username;
  lib.lbImportAt = ex.exportAt ?? nowSec();
  lib.lbSeen = {};
  lib.lbGap = false;
  lib.prune();
  lib.touch();
}

// ---------------------------------------------------------------- RSS sync

class RssItem {
  final String guid;
  final int tmdbId;
  final String title;
  final int? year;
  final double? rating;
  final bool liked;
  final bool rewatch;
  final String? watchedDate;
  final int pubAt;
  const RssItem(this.guid, this.tmdbId, this.title, this.year, this.rating, this.liked, this.rewatch, this.watchedDate, this.pubAt);
  String get sig => '${rating ?? ''}|${liked ? 1 : 0}|${watchedDate ?? ''}';
}

const _months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/// Parses an RFC 822 date ("Tue, 17 Nov 2026 11:22:49 +1300") to epoch seconds.
int? parseRfc822(String s) {
  final m = RegExp(r'(\d{1,2}) (\w{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2})(?: ([+-])(\d{2})(\d{2}))?').firstMatch(s);
  if (m == null) return null;
  final mon = _months.indexOf(m[2]!.toLowerCase());
  if (mon < 0) return null;
  var t = DateTime.utc(int.parse(m[3]!), mon + 1, int.parse(m[1]!), int.parse(m[4]!), int.parse(m[5]!), int.parse(m[6]!));
  if (m[7] != null) {
    final off = Duration(hours: int.parse(m[8]!), minutes: int.parse(m[9]!));
    t = m[7] == '+' ? t.subtract(off) : t.add(off);
  }
  return t.millisecondsSinceEpoch ~/ 1000;
}

/// Diary items of a Letterboxd RSS feed. Lists, TV entries and anything
/// without a TMDB movie id are ignored.
List<RssItem> parseRss(String body) {
  final doc = XmlDocument.parse(body);
  final out = <RssItem>[];
  for (final it in doc.findAllElements('item')) {
    String? t(String n) {
      final e = it.findElements(n);
      return e.isEmpty ? null : e.first.innerText.trim();
    }

    final guid = t('guid');
    final id = int.tryParse(t('tmdb:movieId') ?? '');
    if (guid == null || id == null || !(guid.startsWith('letterboxd-watch') || guid.startsWith('letterboxd-review'))) continue;
    final wd = t('letterboxd:watchedDate');
    out.add(RssItem(
      guid,
      id,
      t('letterboxd:filmTitle') ?? '',
      int.tryParse(t('letterboxd:filmYear') ?? ''),
      double.tryParse(t('letterboxd:memberRating') ?? ''),
      (t('letterboxd:memberLike') ?? '').toLowerCase() == 'yes',
      (t('letterboxd:rewatch') ?? '').toLowerCase() == 'yes',
      wd != null && wd.length >= 10 ? wd.substring(0, 10) : null,
      parseRfc822(t('pubDate') ?? '') ?? _dateSec(wd) ?? nowSec(),
    ));
  }
  return out;
}

String? cleanUsername(String s) {
  var u = s.trim();
  final m = RegExp(r'letterboxd\.com/([A-Za-z0-9_]+)').firstMatch(u);
  if (m != null) u = m[1]!;
  if (u.startsWith('@')) u = u.substring(1);
  return RegExp(r'^[A-Za-z0-9_]{2,40}$').hasMatch(u) ? u : null;
}

class LbNotFound implements Exception {}

Future<List<RssItem>> fetchRss(String username, [http.Client? client]) async {
  final u = cleanUsername(username);
  if (u == null) throw LbNotFound();
  final c = client ?? http.Client();
  try {
    final r = await c.get(Uri.parse('https://letterboxd.com/${u.toLowerCase()}/rss/'),
        headers: {'User-Agent': 'Mozilla/5.0 (compatible; rss-reader)', 'Accept': 'application/rss+xml, application/xml'}).timeout(const Duration(seconds: 25));
    if (r.statusCode == 404) throw LbNotFound();
    if (r.statusCode != 200) throw Exception('Letterboxd answered ${r.statusCode}');
    return parseRss(utf8.decode(r.bodyBytes, allowMalformed: true));
  } finally {
    if (client == null) c.close();
  }
}

class SyncResult {
  int added = 0; // films new to the library
  int updated = 0; // existing films that changed
  bool gap = false;
  final List<int> ids = [];
}

/// Merges RSS diary items into the library.
///
/// * Duplicates: every item is remembered by guid + signature, and films are
///   keyed by TMDB id, so re-reading the feed changes nothing.
/// * Changed ratings: a known guid with a new signature is applied again and
///   stamped "now", so it beats older in-app values.
/// * Rewatches: each distinct watched date counts once.
/// * Gaps: the feed only holds the ~50 latest entries. If none of them is
///   known although we synced before, entries in between were missed.
SyncResult applyRss(Library lib, List<RssItem> items, {int? now}) {
  final res = SyncResult();
  final t = now ?? nowSec();
  final sorted = [...items]..sort((a, b) => a.pubAt.compareTo(b.pubAt));
  if (sorted.length >= 50) {
    final overlap = sorted.any((i) => lib.lbSeen.containsKey(i.guid));
    final since = lib.lbSeen.isNotEmpty ? lib.lbLastSync : lib.lbImportAt;
    if (!overlap && since != null && sorted.first.pubAt > since) res.gap = true;
  }
  for (final it in sorted) {
    final prev = lib.lbSeen[it.guid];
    if (prev == it.sig) continue;
    final isNew = !lib.entries.containsKey(it.tmdbId);
    final e = lib.entry(it.tmdbId);
    final at = prev == null ? it.pubAt : t;
    final before = '${e.lbRating}|${e.lbWatched}|${e.lbLiked}|${e.watchDates.length}|${e.lbWatchlist}';
    e.lbWatched = true;
    final wAt = _dateSec(it.watchedDate) ?? it.pubAt;
    if (e.lbWatchedAt == null || wAt > e.lbWatchedAt!) e.lbWatchedAt = wAt;
    if (it.watchedDate != null && !e.watchDates.contains(it.watchedDate)) e.watchDates.add(it.watchedDate!);
    if (it.rewatch) e.lbRewatch = true;
    // Among Letterboxd entries the most recent one carries the rating; an
    // edited entry replaces its own earlier value.
    if (it.rating != null && it.pubAt >= (e.lbSrcAt ?? 0)) {
      e.lbRating = it.rating;
      e.lbSrcAt = it.pubAt;
      if (e.lbRatingAt == null || at > e.lbRatingAt!) e.lbRatingAt = at;
    }
    if (it.liked) e.lbLiked = true;
    if (e.lbWatchlist) {
      e.lbWatchlist = false; // Letterboxd drops watched films from the watchlist
      e.lbWatchlistAt = at;
    }
    lib.lbSeen[it.guid] = it.sig;
    final after = '${e.lbRating}|${e.lbWatched}|${e.lbLiked}|${e.watchDates.length}|${e.lbWatchlist}';
    if (isNew) {
      res.added++;
      res.ids.add(it.tmdbId);
    } else if (before != after) {
      res.updated++;
      res.ids.add(it.tmdbId);
    }
  }
  if (lib.lbSeen.length > 400) {
    final keep = {for (final i in sorted) i.guid};
    final extra = lib.lbSeen.keys.where((k) => !keep.contains(k)).toList();
    for (final k in extra.take(lib.lbSeen.length - 400)) {
      lib.lbSeen.remove(k);
    }
  }
  if (res.gap) lib.lbGap = true;
  lib.lbLastSync = t;
  if (res.added + res.updated > 0) lib.touch();
  return res;
}
