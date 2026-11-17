import 'dart:convert';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:what_to_watch/core/engine/prompts.dart';
import 'package:what_to_watch/core/engine/request.dart';
import 'package:what_to_watch/core/engine/taste.dart';
import 'package:what_to_watch/core/letterboxd.dart';
import 'package:what_to_watch/core/llm.dart';
import 'package:what_to_watch/core/models.dart';
import 'package:what_to_watch/core/tmdb.dart';

Film film(int id, String title,
        {int year = 2015, int runtime = 110, List<int> genres = const [18], String lang = 'en', double vote = 7.5, int votes = 2000,
        List<String> dir = const ['A Director'], List<Prov> flat = const [], String region = 'DE'}) =>
    Film(id: id, title: title, release: '$year-05-01', runtime: runtime, genres: [...genres], lang: lang, poster: '/p$id.jpg',
        vote: vote, votes: votes, directors: [...dir], prov: Providers(region, flat: flat), full: true);

Uint8List zipOf(Map<String, String> files) {
  final a = Archive();
  files.forEach((name, content) {
    final b = utf8.encode(content);
    a.addFile(ArchiveFile(name, b.length, b));
  });
  return Uint8List.fromList(ZipEncoder().encode(a));
}

void main() {
  group('csv', () {
    test('quotes, commas, newlines', () {
      final rows = parseCsv('Name,Year\n"Crouching Tiger, Hidden Dragon",2000\n"He said ""hi""\nthere",1999\n');
      expect(rows[1], ['Crouching Tiger, Hidden Dragon', '2000']);
      expect(rows[2][0], 'He said "hi"\nthere');
    });
  });

  group('letterboxd zip', () {
    final zip = zipOf({
      'letterboxd-user-2026/profile.csv': 'Date Joined,Username,Favorite Films\n2020-01-01,Tester,https://boxd.it/aaaa\n',
      'letterboxd-user-2026/ratings.csv': 'Date,Name,Year,Letterboxd URI,Rating\n2021-01-02,Alpha,2001,https://boxd.it/aaaa,4.5\n2021-01-03,Beta,2002,https://boxd.it/bbbb,2\n',
      'letterboxd-user-2026/watched.csv': 'Date,Name,Year,Letterboxd URI\n2021-01-02,Alpha,2001,https://boxd.it/aaaa\n2021-01-03,Beta,2002,https://boxd.it/bbbb\n2021-01-04,Gamma,2003,https://boxd.it/cccc\n',
      'letterboxd-user-2026/watchlist.csv': 'Date,Name,Year,Letterboxd URI\n2021-02-01,Delta,2004,https://boxd.it/dddd\n',
      'letterboxd-user-2026/diary.csv': 'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n2021-01-02,Alpha,2001,https://boxd.it/e1,4,,,2021-01-01\n2022-01-02,Alpha,2001,https://boxd.it/e2,4.5,Yes,,2022-01-01\n',
      'letterboxd-user-2026/likes/films.csv': 'Date,Name,Year,Letterboxd URI\n2021-01-04,Gamma,2003,https://boxd.it/cccc\n',
      'letterboxd-user-2026/lists/top-10.csv': 'Letterboxd list export v7\nDate,Name,Tags,URL,Description\n2025-01-03,Top 10,,https://boxd.it/L,\n\nPosition,Name,Year,URL,Description\n1,Gamma,2003,https://boxd.it/cccc,\n',
      'letterboxd-user-2026/deleted/diary.csv': 'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n2021-01-02,Zeta,1990,https://boxd.it/z,1,,,2021-01-01\n',
    });

    test('finds everything by itself', () {
      final ex = parseLetterboxdZip(zip);
      expect(ex.username, 'Tester');
      expect(ex.films.length, 4);
      final alpha = ex.films['alpha|2001']!;
      expect(alpha.rating, 4.5);
      expect(alpha.favorite, isTrue);
      expect(alpha.rewatch, isTrue);
      expect(alpha.watchDates, {'2021-01-01', '2022-01-01'});
      expect(ex.films['gamma|2003']!.liked, isTrue);
      expect(ex.films['gamma|2003']!.favorite, isTrue);
      expect(ex.films['delta|2004']!.watchlist, isTrue);
      expect(ex.films.containsKey('zeta|1990'), isFalse);
    });

    test('rejects other zips', () {
      expect(() => parseLetterboxdZip(zipOf({'hello.txt': 'x'})), throwsA(isA<LbFormatException>()));
      expect(() => parseLetterboxdZip(Uint8List.fromList([1, 2, 3])), throwsA(isA<LbFormatException>()));
    });

    test('apply keeps in-app data and replaces the Letterboxd side', () {
      final ex = parseLetterboxdZip(zip);
      var id = 1;
      for (final f in ex.films.values) {
        f.tmdbId = f.name == 'Beta' ? null : id++;
      }
      final lib = Library()..rate(99, 3.5);
      lib.entry(50).lbRating = 1; // stale Letterboxd value, gone from the export
      applyExport(lib, ex);
      expect(lib[99]!.rating, 3.5);
      expect(lib[50], isNull);
      expect(lib.unmatched, ['Beta (2002)']);
      expect(lib.lbUsername, 'Tester');
      expect(lib.rated.length, 2);
    });
  });

  group('merge rules', () {
    test('latest change wins, rated implies watched, watched leaves watchlist', () {
      final lib = Library();
      final e = lib.entry(1)
        ..lbRating = 3
        ..lbRatingAt = nowSec() - 1000
        ..lbWatchlist = true
        ..lbWatchlistAt = 5;
      expect(e.rating, 3);
      expect(e.watched, isTrue);
      expect(e.watchlist, isFalse);
      lib.rate(1, 4.5);
      expect(e.rating, 4.5);
      e
        ..lbRating = 2
        ..lbRatingAt = nowSec() + 50; // newer Letterboxd rating arrives later
      expect(e.rating, 2);
      lib.rate(2, null);
      expect(lib[2]!.rating, isNull);
      lib.setWatchlist(3, true);
      expect(lib[3]!.watchlist, isTrue);
      lib.setWatched(3, true);
      expect(lib[3]!.watchlist, isFalse);
      lib.setWatched(1, false);
      expect(e.watched, isTrue, reason: 'the newer Letterboxd rating still stands');
    });

    test('json round trip', () {
      final lib = Library()
        ..rate(1, 4)
        ..setNotInterested(2, true)
        ..lbUsername = 'x';
      final back = Library.fromJson(jsonDecode(jsonEncode(lib.toJson())) as Map<String, dynamic>);
      expect(back[1]!.rating, 4);
      expect(back[2]!.notInterested, isTrue);
      expect(back.lbUsername, 'x');
    });
  });

  group('rss', () {
    String item(int n, int tmdb, String date, {double? rating, bool rewatch = false, String kind = 'watch'}) => '''
<item><title>Film $tmdb</title><guid isPermaLink="false">letterboxd-$kind-$n</guid>
<pubDate>${DateTime.parse('${date}T10:00:00Z').toUtc().day} Nov 2026 10:00:00 +0100</pubDate>
<letterboxd:watchedDate>$date</letterboxd:watchedDate><letterboxd:rewatch>${rewatch ? 'Yes' : 'No'}</letterboxd:rewatch>
<letterboxd:filmTitle>Film $tmdb</letterboxd:filmTitle><letterboxd:filmYear>2020</letterboxd:filmYear>
${rating == null ? '' : '<letterboxd:memberRating>$rating</letterboxd:memberRating>'}<letterboxd:memberLike>No</letterboxd:memberLike>
<tmdb:movieId>$tmdb</tmdb:movieId></item>''';
    String feed(List<String> items) =>
        '<?xml version="1.0"?><rss version="2.0" xmlns:letterboxd="https://letterboxd.com" xmlns:tmdb="https://themoviedb.org"><channel>${items.join()}'
        '<item><title>A list</title><guid>letterboxd-list-1</guid></item></channel></rss>';

    test('parses diary items only', () {
      final items = parseRss(feed([item(1, 10, '2026-11-02', rating: 4.0), item(2, 11, '2026-11-03')]));
      expect(items.length, 2);
      expect(items.first.tmdbId, 10);
      expect(items.first.rating, 4.0);
      expect(items.first.pubAt, DateTime.utc(2026, 11, 2, 9).millisecondsSinceEpoch ~/ 1000);
      expect(items[1].rating, isNull);
    });

    test('duplicates, changed ratings, rewatches', () {
      final lib = Library()..setWatchlist(10, true);
      lib[10]!.lbWatchlist = true;
      var res = applyRss(lib, parseRss(feed([item(1, 10, '2026-11-02', rating: 4.0)])));
      expect(res.updated + res.added, 1);
      expect(lib[10]!.rating, 4.0);
      expect(lib[10]!.watchlist, isFalse);
      res = applyRss(lib, parseRss(feed([item(1, 10, '2026-11-02', rating: 4.0)])));
      expect(res.added + res.updated, 0, reason: 'same feed twice changes nothing');
      res = applyRss(lib, parseRss(feed([item(1, 10, '2026-11-02', rating: 2.5)])));
      expect(lib[10]!.rating, 2.5, reason: 'edited rating is picked up');
      res = applyRss(lib, parseRss(feed([item(1, 10, '2026-11-02', rating: 2.5), item(7, 10, '2026-11-09', rating: 5.0, rewatch: true)])));
      expect(lib[10]!.rating, 5.0);
      expect(lib[10]!.rewatched, isTrue);
      expect(lib[10]!.watchDates.length, 2);
    });

    test('in-app rating beats older Letterboxd entry, loses to newer', () {
      final lib = Library()..rate(10, 1.0);
      applyRss(lib, parseRss(feed([item(1, 10, '2026-11-02', rating: 4.0)])));
      expect(lib[10]!.rating, 1.0);
      lib[10]!.myRatingAt = 100; // pretend the in-app rating is old
      applyRss(lib, parseRss(feed([item(2, 10, '2026-11-05', rating: 3.0)])));
      expect(lib[10]!.rating, 3.0);
    });

    test('detects a gap after a long absence', () {
      final lib = Library();
      applyRss(lib, parseRss(feed([for (var i = 0; i < 50; i++) item(i, 100 + i, '2026-11-01', rating: 3.0)])), now: 1000);
      expect(lib.lbGap, isFalse);
      final res = applyRss(lib, parseRss(feed([for (var i = 100; i < 150; i++) item(i, 300 + i, '2026-11-20', rating: 3.0)])));
      expect(res.gap, isTrue);
      expect(lib.lbGap, isTrue);
    });

    test('username cleaning', () {
      expect(cleanUsername(' https://letterboxd.com/Some_User/ '), 'Some_User');
      expect(cleanUsername('@abc'), 'abc');
      expect(cleanUsername('bad name/../x'), isNull);
    });
  });

  group('title matching', () {
    test('scores', () {
      final glass = film(1, 'Glass Onion: A Knives Out Mystery', year: 2022, votes: 5000);
      final other = film(2, 'Onion', year: 2022, votes: 20);
      expect(matchScore(glass, 'Glass Onion', 2022), greaterThan(100));
      expect(matchScore(other, 'Glass Onion', 2022), lessThan(100));
      expect(matchScore(film(3, 'Amélie', year: 2001), 'Amelie', 2001), greaterThan(130));
      expect(matchScore(film(4, 'Dune', year: 1984), 'Dune', 2021), lessThan(100));
    });
  });

  group('hard filters', () {
    final netflix = const Prov(8, 'Netflix', null);
    final sv = const Services('DE', {8: 'Netflix'});
    final lib = Library();
    final ok = film(1, 'Ok', flat: [netflix]);

    test('passes when everything fits', () {
      final r = Request(genres: {18}, yearMin: 2010, yearMax: 2020, runMin: 90, runMax: 120, langs: {'en'}, streamingOnly: true);
      expect(rejectReason(ok, r, lib, sv), isNull);
    });
    test('each filter rejects', () {
      expect(rejectReason(ok, Request(genres: {18, 35}), lib, sv), 'genre');
      expect(rejectReason(ok, Request(notGenres: {18}), lib, sv), 'genre');
      expect(rejectReason(ok, Request(yearMin: 2016), lib, sv), 'year');
      expect(rejectReason(ok, Request(yearMax: 2014), lib, sv), 'year');
      expect(rejectReason(ok, Request(runMax: 100), lib, sv), 'runtime');
      expect(rejectReason(ok, Request(runMin: 120), lib, sv), 'runtime');
      expect(rejectReason(ok, Request(langs: {'fr'}), lib, sv), 'language');
      expect(rejectReason(film(2, 'Elsewhere', flat: [const Prov(337, 'Disney Plus', null)]), Request(streamingOnly: true), lib, sv), 'streaming');
      expect(rejectReason(film(3, 'Other region', flat: [netflix], region: 'US'), Request(streamingOnly: true), lib, sv), 'streaming');
      expect(rejectReason(film(4, 'Ads tier', flat: [const Prov(1796, 'Netflix Standard with Ads', null)]), Request(streamingOnly: true), lib, sv), isNull);
      expect(rejectReason(ok, Request(), lib, sv, shown: {1}), 'shown');
      expect(rejectReason(film(5, 'Unknown runtime', runtime: 0), Request(runMax: 100), lib, sv), 'runtime');
      expect(rejectReason(Film(id: 6, title: 'Future', release: '2999-01-01', poster: '/x', votes: 100, full: true), Request(), lib, sv), 'unreleased');
    });
    test('watched and dismissed films', () {
      final l = Library()
        ..rate(1, 4)
        ..setNotInterested(7, true);
      expect(rejectReason(ok, Request(), l, sv), 'watched');
      expect(rejectReason(ok, Request(excludeWatched: false), l, sv), isNull);
      expect(rejectReason(film(7, 'No'), Request(excludeWatched: false), l, sv), 'not interested');
    });
  });

  group('taste model', () {
    test('learns a simple preference', () {
      final cache = FilmCache();
      final lib = Library();
      for (var i = 0; i < 60; i++) {
        final western = i.isEven;
        cache.put(film(i, 'F$i', genres: [western ? 37 : 35], dir: [western ? 'Loved Director' : 'Other $i'], vote: 6.5 + (i % 5) * 0.2));
        lib.rate(i, western ? 4.5 : 2.0);
      }
      final m = TasteModel.fromLibrary(lib, cache);
      expect(m.learned, isTrue);
      final w = m.predict(film(1000, 'New western', genres: [37], dir: ['Loved Director'])).rating;
      final c = m.predict(film(1001, 'New comedy', genres: [35], dir: ['Someone'])).rating;
      expect(w, greaterThan(c + 1));
      expect(m.top('g'), contains('Western'));
      expect(m.predict(film(1000, 'New western', genres: [37], dir: ['Loved Director'])).neighbors, isNotEmpty);
    });
    test('works with an empty library', () {
      final m = TasteModel.fromLibrary(Library(), FilmCache());
      expect(m.predict(film(1, 'Great', vote: 8.4, votes: 9000)).rating, greaterThan(m.predict(film(2, 'Poor', vote: 4.8, votes: 9000)).rating));
    });
  });

  group('explanations', () {
    final cache = FilmCache()
      ..put(film(1, 'Loved Film'))
      ..put(film(2, 'Hated Film'));
    final lib = Library()
      ..rate(1, 4.5)
      ..rate(2, 1.5);
    final tags = {'L1': 1, 'L2': 2};
    test('tags become titles and are recorded', () {
      final w = validateWhy('Shares the slow-burn tension of [L1] and fits a quiet night.', tags, lib, cache)!;
      expect(w.text, 'Shares the slow-burn tension of Loved Film and fits a quiet night.');
      expect(w.refs, [1]);
    });
    test('rejects unknown tags, low-rated anchors and star claims', () {
      expect(validateWhy('Just like [L9], which you adored.', tags, lib, cache), isNull);
      expect(validateWhy('You loved [L2], so this is for you.', tags, lib, cache), isNull);
      expect(validateWhy('You gave [L1] 5 stars, so this is for you.', tags, lib, cache), isNull);
    });
    test('taste brief hides held-out films and tags the rest', () {
      final b = tasteBrief(lib, cache, null, tagged: true, hide: {2});
      expect(b.text, contains('[L1] Loved Film (2015)'));
      expect(b.text, isNot(contains('Hated Film')));
      expect(b.tags, {'L1': 1});
    });
  });

  group('llm output parsing', () {
    test('json with prose and fences', () {
      expect(extractJson('Sure!\n```json\n{"picks":[{"t":"A","y":1}]}\n```')!['picks'], isNotEmpty);
      expect(extractJson('nothing here'), isNull);
    });
    test('json lines', () {
      final rows = extractJsonLines('{"c":1,"r":4}\nnoise\n{"c":2,"r":3.5},\n{broken');
      expect(rows.length, 2);
      expect(rows[1]['r'], 3.5);
    });
  });
}
