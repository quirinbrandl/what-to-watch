import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'models.dart';

/// Runs at most [max] tasks at once.
class Pool {
  final int max;
  int _running = 0;
  final _queue = <Completer<void>>[];
  Pool(this.max);

  Future<T> run<T>(Future<T> Function() task) async {
    if (_running >= max) {
      final c = Completer<void>();
      _queue.add(c);
      await c.future;
    } else {
      _running++;
    }
    try {
      return await task();
    } finally {
      if (_queue.isNotEmpty) {
        _queue.removeAt(0).complete();
      } else {
        _running--;
      }
    }
  }
}

class TmdbException implements Exception {
  final int status;
  final String message;
  TmdbException(this.status, this.message);
  @override
  String toString() => 'TMDB error $status: $message';
}

/// In-memory film cache shared by the whole app. Persistence is handled by
/// the caller (see `Store`), which serialises [films].
class FilmCache {
  final Map<int, Film> films = {};

  Film? operator [](int id) => films[id];

  /// Insert a film, never downgrading a full record to a list-level one.
  Film put(Film f) {
    final old = films[f.id];
    if (old != null && old.full && !f.full) {
      old.vote = f.vote;
      old.votes = f.votes;
      old.pop = f.pop;
      return old;
    }
    films[f.id] = f;
    return f;
  }

  Map<String, dynamic> toJson() => {
        'films': [for (final f in films.values) f.toJson()]
      };

  void load(Map<String, dynamic> j) {
    for (final f in (j['films'] as List? ?? const [])) {
      final film = Film.fromJson((f as Map).cast<String, dynamic>());
      films[film.id] = film;
    }
  }

  /// Keep the cache bounded: drop the stalest films that are not in [keep].
  void prune(Set<int> keep, {int max = 6000}) {
    if (films.length <= max) return;
    final rest = films.values.where((f) => !keep.contains(f.id)).toList()..sort((a, b) => a.at.compareTo(b.at));
    for (final f in rest.take(films.length - max)) {
      films.remove(f.id);
    }
  }
}

class Tmdb {
  /// Read-only TMDB API token, embedded on purpose (see README): it only
  /// grants access to public movie metadata and images.
  static const readToken =
      'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJmY2FiZDVhMWU5OTY2YmEzM2MyMTU1ZTYyMGI5NDczZSIsIm5iZiI6MTc3MjY1NDI0NS41MjQsInN1YiI6IjY5YTg4ZWE1ZTE0M2QyY2RlMjA4MGI1ZiIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.IxTOK2570KkFtZXlpsk857fVwqnylZZ1fzSEzecrQUk';
  static const _base = 'https://api.themoviedb.org/3';

  static String img(String path, [String size = 'w500']) => 'https://image.tmdb.org/t/p/$size$path';

  final http.Client _http;
  final FilmCache cache;
  final _pool = Pool(12);
  final _mem = <String, dynamic>{};
  int calls = 0;

  Tmdb(this.cache, [http.Client? client]) : _http = client ?? http.Client();

  Future<dynamic> get(String path, [Map<String, String> q = const {}, bool memo = true]) async {
    final uri = Uri.parse('$_base$path').replace(queryParameters: {'language': 'en-US', ...q});
    final key = uri.toString();
    if (memo && _mem.containsKey(key)) return _mem[key];
    final body = await _pool.run(() async {
      for (var attempt = 0;; attempt++) {
        try {
          calls++;
          final r = await _http
              .get(uri, headers: {'Authorization': 'Bearer $readToken', 'Accept': 'application/json'}).timeout(const Duration(seconds: 20));
          if (r.statusCode == 200) return jsonDecode(utf8.decode(r.bodyBytes));
          if ((r.statusCode == 429 || r.statusCode >= 500) && attempt < 4) {
            await Future<void>.delayed(Duration(milliseconds: 400 * (attempt + 1) * (attempt + 1)));
            continue;
          }
          throw TmdbException(r.statusCode, r.statusCode == 404 ? 'Not found' : 'Request failed');
        } on TmdbException {
          rethrow;
        } catch (e) {
          if (attempt >= 3) throw TmdbException(0, 'Network problem');
          await Future<void>.delayed(Duration(milliseconds: 500 * (attempt + 1)));
        }
      }
    });
    if (memo) _mem[key] = body;
    return body;
  }

  List<Film> _list(dynamic body) => [
        for (final r in (body['results'] as List? ?? const []))
          if (r is Map && r['id'] is int && r['adult'] != true) cache.put(Film.fromList(r.cast<String, dynamic>()))
      ];

  /// Full film details. Served from cache when fresh for this region.
  Future<Film> details(int id, String region, {int maxAgeDays = 30, int providerMaxAgeDays = 3}) async {
    final c = cache[id];
    final now = nowSec();
    if (c != null && c.full && now - c.at < maxAgeDays * 86400) {
      final p = c.prov;
      if (p != null && p.region == region && now - p.at < providerMaxAgeDays * 86400) return c;
    }
    final j = await get('/movie/$id', {'append_to_response': 'keywords,credits,watch/providers,recommendations'}, false);
    final recs = (j['recommendations']?['results'] as List?) ?? const [];
    for (final r in recs) {
      if (r is Map && r['id'] is int && r['adult'] != true) cache.put(Film.fromList(r.cast<String, dynamic>()));
    }
    final f = Film.fromDetails((j as Map).cast<String, dynamic>(), region);
    cache.films[id] = f;
    return f;
  }

  /// Details for many films; failures are skipped (returned list may be shorter).
  Future<List<Film>> detailsAll(Iterable<int> ids, String region, {void Function(Film)? onEach, int providerMaxAgeDays = 3}) async {
    final out = await Future.wait(ids.map((id) async {
      try {
        final f = await details(id, region, providerMaxAgeDays: providerMaxAgeDays);
        onEach?.call(f);
        return f;
      } catch (_) {
        return null;
      }
    }));
    return out.whereType<Film>().toList();
  }

  Future<List<Film>> search(String query, {int? year, bool primary = false}) async =>
      _list(await get('/search/movie', {
        'query': query,
        'include_adult': 'false',
        if (year != null) (primary ? 'primary_release_year' : 'year'): '$year',
      }));

  Future<List<Film>> recommendations(int id, {int page = 1}) async => _list(await get('/movie/$id/recommendations', {'page': '$page'}));

  Future<List<Film>> similar(int id) async => _list(await get('/movie/$id/similar'));

  Future<List<Film>> discover(Map<String, String> q, {int page = 1}) async =>
      _list(await get('/discover/movie', {'include_adult': 'false', 'include_video': 'false', ...q, 'page': '$page'}));

  Future<List<Film>> trending() async => _list(await get('/trending/movie/week'));

  Future<List<Film>> popularTop({int page = 1}) async => _list(await get('/movie/top_rated', {'page': '$page'}));

  /// Streaming services offered in a region, most relevant first.
  Future<List<Prov>> providerCatalog(String region) async {
    final j = await get('/watch/providers/movie', {'watch_region': region});
    final l = [for (final p in (j['results'] as List? ?? const [])) p as Map];
    int prio(Map p) => ((p['display_priorities'] as Map?)?[region] as num? ?? p['display_priority'] as num? ?? 999).toInt();
    l.sort((a, b) => prio(a).compareTo(prio(b)));
    return [for (final p in l) Prov(p['provider_id'] as int, (p['provider_name'] ?? '') as String, p['logo_path'] as String?)];
  }
}
