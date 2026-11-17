/// Core data model. Everything under lib/core is pure Dart (no Flutter
/// imports) so the same code runs in the app and in the offline eval CLI.
library;

int nowSec() => DateTime.now().millisecondsSinceEpoch ~/ 1000;

const Map<int, String> kGenres = {
  28: 'Action',
  12: 'Adventure',
  16: 'Animation',
  35: 'Comedy',
  80: 'Crime',
  99: 'Documentary',
  18: 'Drama',
  10751: 'Family',
  14: 'Fantasy',
  36: 'History',
  27: 'Horror',
  10402: 'Music',
  9648: 'Mystery',
  10749: 'Romance',
  878: 'Sci-Fi',
  53: 'Thriller',
  10752: 'War',
  37: 'Western',
};

const Map<String, String> kLanguages = {
  'en': 'English',
  'fr': 'French',
  'de': 'German',
  'es': 'Spanish',
  'it': 'Italian',
  'ja': 'Japanese',
  'ko': 'Korean',
  'zh': 'Mandarin',
  'cn': 'Cantonese',
  'hi': 'Hindi',
  'pt': 'Portuguese',
  'sv': 'Swedish',
  'da': 'Danish',
  'no': 'Norwegian',
  'nl': 'Dutch',
  'pl': 'Polish',
  'ru': 'Russian',
  'tr': 'Turkish',
  'fa': 'Persian',
  'ar': 'Arabic',
  'th': 'Thai',
  'id': 'Indonesian',
  'fi': 'Finnish',
  'el': 'Greek',
  'he': 'Hebrew',
  'ta': 'Tamil',
  'te': 'Telugu',
};

class Kw {
  final int id;
  final String name;
  const Kw(this.id, this.name);
}

class Prov {
  final int id;
  final String name;
  final String? logo;
  const Prov(this.id, this.name, this.logo);
  List<dynamic> toJson() => [id, name, logo];
  static Prov fromJson(dynamic j) => Prov(j[0] as int, j[1] as String, j[2] as String?);
  static List<Prov> listFromTmdb(dynamic l) => l is List
      ? [for (final p in l) Prov(p['provider_id'] as int, (p['provider_name'] ?? '') as String, p['logo_path'] as String?)]
      : const [];
}

/// Watch providers of one film in one region (TMDB / JustWatch data).
class Providers {
  final String region;
  final List<Prov> flat, free, ads, rent, buy;
  final String? link;
  final int at;
  const Providers(this.region,
      {this.flat = const [], this.free = const [], this.ads = const [], this.rent = const [], this.buy = const [], this.link, this.at = 0});

  /// Providers where the film is included at no extra cost per title.
  List<Prov> get streamable {
    final seen = <int>{};
    return [
      for (final p in [...flat, ...free, ...ads])
        if (seen.add(p.id)) p
    ];
  }

  Map<String, dynamic> toJson() => {
        'r': region,
        'fl': [for (final p in flat) p.toJson()],
        'fr': [for (final p in free) p.toJson()],
        'ad': [for (final p in ads) p.toJson()],
        're': [for (final p in rent) p.toJson()],
        'bu': [for (final p in buy) p.toJson()],
        if (link != null) 'l': link,
        'at': at,
      };
  static Providers fromJson(Map<String, dynamic> j) {
    List<Prov> l(String k) => [for (final p in (j[k] as List? ?? const [])) Prov.fromJson(p)];
    return Providers(j['r'] as String,
        flat: l('fl'), free: l('fr'), ads: l('ad'), rent: l('re'), buy: l('bu'), link: j['l'] as String?, at: j['at'] as int? ?? 0);
  }
}

/// A TMDB film. `full` means it carries details (runtime, keywords, credits,
/// providers, recommendations); otherwise only list-level fields are known.
class Film {
  final int id;
  String title;
  String? original;
  String? release; // yyyy-mm-dd
  int? runtime;
  List<int> genres;
  String? lang;
  String? poster;
  String? backdrop;
  String overview;
  double vote;
  int votes;
  double pop;
  List<String> directors;
  List<String> cast;
  List<Kw> keywords;
  List<int> recs;
  Providers? prov;
  bool full;
  bool adult;
  int at;

  Film({
    required this.id,
    required this.title,
    this.original,
    this.release,
    this.runtime,
    List<int>? genres,
    this.lang,
    this.poster,
    this.backdrop,
    this.overview = '',
    this.vote = 0,
    this.votes = 0,
    this.pop = 0,
    List<String>? directors,
    List<String>? cast,
    List<Kw>? keywords,
    List<int>? recs,
    this.prov,
    this.full = false,
    this.adult = false,
    int? at,
  })  : genres = genres ?? [],
        directors = directors ?? [],
        cast = cast ?? [],
        keywords = keywords ?? [],
        recs = recs ?? [],
        at = at ?? nowSec();

  int? get year => (release != null && release!.length >= 4) ? int.tryParse(release!.substring(0, 4)) : null;
  int? get decade => year == null ? null : (year! ~/ 10) * 10;
  bool get released => release != null && release!.isNotEmpty && release!.compareTo(DateTime.now().toIso8601String().substring(0, 10)) <= 0;
  String get label => year == null ? title : '$title ($year)';
  List<String> get genreNames => [for (final g in genres) if (kGenres[g] != null) kGenres[g]!];

  /// Bayesian-shrunk TMDB score (protects against 10.0 from 3 votes).
  double get score => votes <= 0 ? 6.3 : (vote * votes + 6.3 * 150) / (votes + 150);

  factory Film.fromList(Map<String, dynamic> j) => Film(
        id: j['id'] as int,
        title: (j['title'] ?? j['original_title'] ?? '') as String,
        original: j['original_title'] as String?,
        release: j['release_date'] as String?,
        genres: [for (final g in (j['genre_ids'] as List? ?? const [])) g as int],
        lang: j['original_language'] as String?,
        poster: j['poster_path'] as String?,
        backdrop: j['backdrop_path'] as String?,
        overview: (j['overview'] ?? '') as String,
        vote: (j['vote_average'] as num? ?? 0).toDouble(),
        votes: (j['vote_count'] as num? ?? 0).toInt(),
        pop: (j['popularity'] as num? ?? 0).toDouble(),
        adult: j['adult'] == true,
      );

  /// From /movie/{id}?append_to_response=keywords,credits,watch/providers,recommendations
  factory Film.fromDetails(Map<String, dynamic> j, String region) {
    final crew = (j['credits']?['crew'] as List?) ?? const [];
    final cast = (j['credits']?['cast'] as List?) ?? const [];
    final kws = (j['keywords']?['keywords'] as List?) ?? const [];
    final recs = (j['recommendations']?['results'] as List?) ?? const [];
    final pr = (j['watch/providers']?['results'] as Map?)?[region] as Map?;
    return Film(
      id: j['id'] as int,
      title: (j['title'] ?? j['original_title'] ?? '') as String,
      original: j['original_title'] as String?,
      release: j['release_date'] as String?,
      runtime: (j['runtime'] as num?)?.toInt(),
      genres: [for (final g in (j['genres'] as List? ?? const [])) g['id'] as int],
      lang: j['original_language'] as String?,
      poster: j['poster_path'] as String?,
      backdrop: j['backdrop_path'] as String?,
      overview: (j['overview'] ?? '') as String,
      vote: (j['vote_average'] as num? ?? 0).toDouble(),
      votes: (j['vote_count'] as num? ?? 0).toInt(),
      pop: (j['popularity'] as num? ?? 0).toDouble(),
      directors: [
        for (final c in crew)
          if (c['job'] == 'Director') c['name'] as String
      ],
      cast: [for (final c in cast.take(6)) c['name'] as String],
      keywords: [for (final k in kws) Kw(k['id'] as int, k['name'] as String)],
      recs: [for (final r in recs) r['id'] as int],
      prov: Providers(region,
          flat: Prov.listFromTmdb(pr?['flatrate']),
          free: Prov.listFromTmdb(pr?['free']),
          ads: Prov.listFromTmdb(pr?['ads']),
          rent: Prov.listFromTmdb(pr?['rent']),
          buy: Prov.listFromTmdb(pr?['buy']),
          link: pr?['link'] as String?,
          at: nowSec()),
      full: true,
      adult: j['adult'] == true,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        't': title,
        if (original != null && original != title) 'o': original,
        if (release != null) 'd': release,
        if (runtime != null) 'rt': runtime,
        'g': genres,
        if (lang != null) 'l': lang,
        if (poster != null) 'p': poster,
        if (backdrop != null) 'b': backdrop,
        if (overview.isNotEmpty) 'ov': overview,
        'v': vote,
        'n': votes,
        'pp': pop,
        if (directors.isNotEmpty) 'dir': directors,
        if (cast.isNotEmpty) 'c': cast,
        if (keywords.isNotEmpty) 'k': [for (final k in keywords) [k.id, k.name]],
        if (recs.isNotEmpty) 'rc': recs,
        if (prov != null) 'pr': prov!.toJson(),
        if (full) 'f': 1,
        if (adult) 'a': 1,
        'at': at,
      };

  static Film fromJson(Map<String, dynamic> j) => Film(
        id: j['id'] as int,
        title: j['t'] as String,
        original: j['o'] as String?,
        release: j['d'] as String?,
        runtime: j['rt'] as int?,
        genres: [for (final g in (j['g'] as List? ?? const [])) g as int],
        lang: j['l'] as String?,
        poster: j['p'] as String?,
        backdrop: j['b'] as String?,
        overview: (j['ov'] ?? '') as String,
        vote: (j['v'] as num? ?? 0).toDouble(),
        votes: (j['n'] as num? ?? 0).toInt(),
        pop: (j['pp'] as num? ?? 0).toDouble(),
        directors: [for (final d in (j['dir'] as List? ?? const [])) d as String],
        cast: [for (final d in (j['c'] as List? ?? const [])) d as String],
        keywords: [for (final k in (j['k'] as List? ?? const [])) Kw(k[0] as int, k[1] as String)],
        recs: [for (final r in (j['rc'] as List? ?? const [])) r as int],
        prov: j['pr'] == null ? null : Providers.fromJson((j['pr'] as Map).cast<String, dynamic>()),
        full: j['f'] == 1,
        adult: j['a'] == 1,
        at: j['at'] as int?,
      );
}

/// One film in the user's library. Letterboxd-side and in-app values are kept
/// separately; getters resolve them with one rule: the latest change wins.
/// Derived rules: rated ⇒ watched, watched ⇒ not on the watchlist.
class Entry {
  final int id;

  // Letterboxd side (ZIP export + RSS).
  double? lbRating;
  int? lbRatingAt; // when this value took effect (compared with in-app changes)
  int? lbSrcAt; // date of the Letterboxd entry it came from (orders Letterboxd entries)
  bool lbWatched = false;
  int? lbWatchedAt;
  bool lbWatchlist = false;
  int? lbWatchlistAt;
  bool lbLiked = false;
  bool favorite = false;
  bool lbRewatch = false;
  List<String> watchDates = [];

  // In-app side. A non-null timestamp with a null value means "cleared here".
  double? myRating;
  int? myRatingAt;
  bool? myWatched;
  int? myWatchedAt;
  bool? myWatchlist;
  int? myWatchlistAt;
  bool notInterested = false;
  int? niAt;

  Entry(this.id);

  static bool _mine(int? my, int? lb) => my != null && (lb == null || my >= lb);

  double? get rating => _mine(myRatingAt, lbRatingAt) ? myRating : lbRating;
  int? get ratingAt => _mine(myRatingAt, lbRatingAt) ? myRatingAt : lbRatingAt;

  bool get watched {
    if (rating != null) return true;
    if (_mine(myWatchedAt, lbWatchedAt)) return myWatched ?? false;
    return lbWatched;
  }

  int? get watchedAt {
    final a = [lbWatchedAt, myWatched == true ? myWatchedAt : null, ratingAt].whereType<int>();
    return a.isEmpty ? null : a.reduce((x, y) => x > y ? x : y);
  }

  bool get watchlist {
    if (watched) return false;
    if (_mine(myWatchlistAt, lbWatchlistAt)) return myWatchlist ?? false;
    return lbWatchlist;
  }

  int? get watchlistAt => _mine(myWatchlistAt, lbWatchlistAt) ? myWatchlistAt : lbWatchlistAt;
  bool get liked => lbLiked || favorite;
  bool get rewatched => lbRewatch || watchDates.length > 1;
  bool get hasLetterboxd => lbRating != null || lbWatched || lbWatchlist || lbLiked || favorite;
  bool get isEmpty =>
      !hasLetterboxd && myRating == null && myWatched != true && myWatchlist != true && !notInterested;

  void clearLetterboxd() {
    lbRating = null;
    lbRatingAt = null;
    lbSrcAt = null;
    lbWatched = false;
    lbWatchedAt = null;
    lbWatchlist = false;
    lbWatchlistAt = null;
    lbLiked = false;
    favorite = false;
    lbRewatch = false;
    watchDates = [];
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        if (lbRating != null) 'lr': lbRating,
        if (lbRatingAt != null) 'lra': lbRatingAt,
        if (lbSrcAt != null) 'lsa': lbSrcAt,
        if (lbWatched) 'lw': 1,
        if (lbWatchedAt != null) 'lwa': lbWatchedAt,
        if (lbWatchlist) 'll': 1,
        if (lbWatchlistAt != null) 'lla': lbWatchlistAt,
        if (lbLiked) 'lk': 1,
        if (favorite) 'fav': 1,
        if (lbRewatch) 'rw': 1,
        if (watchDates.isNotEmpty) 'wd': watchDates,
        if (myRating != null) 'mr': myRating,
        if (myRatingAt != null) 'mra': myRatingAt,
        if (myWatched != null) 'mw': myWatched! ? 1 : 0,
        if (myWatchedAt != null) 'mwa': myWatchedAt,
        if (myWatchlist != null) 'ml': myWatchlist! ? 1 : 0,
        if (myWatchlistAt != null) 'mla': myWatchlistAt,
        if (notInterested) 'ni': 1,
        if (niAt != null) 'nia': niAt,
      };

  static Entry fromJson(Map<String, dynamic> j) => Entry(j['id'] as int)
    ..lbRating = (j['lr'] as num?)?.toDouble()
    ..lbRatingAt = j['lra'] as int?
    ..lbSrcAt = j['lsa'] as int?
    ..lbWatched = j['lw'] == 1
    ..lbWatchedAt = j['lwa'] as int?
    ..lbWatchlist = j['ll'] == 1
    ..lbWatchlistAt = j['lla'] as int?
    ..lbLiked = j['lk'] == 1
    ..favorite = j['fav'] == 1
    ..lbRewatch = j['rw'] == 1
    ..watchDates = [for (final d in (j['wd'] as List? ?? const [])) d as String]
    ..myRating = (j['mr'] as num?)?.toDouble()
    ..myRatingAt = j['mra'] as int?
    ..myWatched = j['mw'] == null ? null : j['mw'] == 1
    ..myWatchedAt = j['mwa'] as int?
    ..myWatchlist = j['ml'] == null ? null : j['ml'] == 1
    ..myWatchlistAt = j['mla'] as int?
    ..notInterested = j['ni'] == 1
    ..niAt = j['nia'] as int?;
}

/// The user's whole library plus Letterboxd sync bookkeeping.
class Library {
  final Map<int, Entry> entries = {};
  String? lbUsername;
  int? lbImportAt; // when a ZIP export was last imported
  int? lbLastSync; // last successful RSS sync
  Map<String, String> lbSeen = {}; // RSS guid -> signature of what we applied
  bool lbGap = false; // RSS may have missed entries (>50 logs between syncs)
  List<String> unmatched = []; // Letterboxd films we could not find on TMDB
  int rev = 0; // bumped on every change (cache key for the taste model)

  Entry entry(int id) => entries.putIfAbsent(id, () => Entry(id));
  Entry? operator [](int id) => entries[id];

  Iterable<Entry> get rated => entries.values.where((e) => e.rating != null);
  Iterable<Entry> get watched => entries.values.where((e) => e.watched);
  Iterable<Entry> get watchlist => entries.values.where((e) => e.watchlist);

  void touch() => rev++;

  void prune() => entries.removeWhere((_, e) => e.isEmpty);

  // In-app actions. Each stamps "now", so it wins until Letterboxd reports
  // something newer for the same field.
  void rate(int id, double? stars) {
    final e = entry(id);
    e.myRating = stars;
    e.myRatingAt = nowSec();
    if (stars != null) {
      e.myWatched = true;
      e.myWatchedAt = e.myRatingAt;
      e.notInterested = false;
    }
    touch();
  }

  void setWatched(int id, bool v) {
    final e = entry(id);
    e.myWatched = v;
    e.myWatchedAt = nowSec();
    if (!v && e.rating != null) {
      e.myRating = null;
      e.myRatingAt = e.myWatchedAt;
    }
    if (v) e.notInterested = false;
    touch();
  }

  void setWatchlist(int id, bool v) {
    final e = entry(id);
    e.myWatchlist = v;
    e.myWatchlistAt = nowSec();
    if (v) e.notInterested = false;
    touch();
  }

  void setNotInterested(int id, bool v) {
    final e = entry(id);
    e.notInterested = v;
    e.niAt = nowSec();
    if (v && e.watchlist) {
      e.myWatchlist = false;
      e.myWatchlistAt = e.niAt;
    }
    touch();
  }

  Map<String, dynamic> toJson() => {
        'v': 1,
        'entries': [for (final e in entries.values) if (!e.isEmpty) e.toJson()],
        if (lbUsername != null) 'lbUser': lbUsername,
        if (lbImportAt != null) 'lbImportAt': lbImportAt,
        if (lbLastSync != null) 'lbLastSync': lbLastSync,
        'lbSeen': lbSeen,
        if (lbGap) 'lbGap': true,
        if (unmatched.isNotEmpty) 'unmatched': unmatched,
      };

  static Library fromJson(Map<String, dynamic> j) {
    final l = Library();
    for (final e in (j['entries'] as List? ?? const [])) {
      final en = Entry.fromJson((e as Map).cast<String, dynamic>());
      l.entries[en.id] = en;
    }
    l.lbUsername = j['lbUser'] as String?;
    l.lbImportAt = j['lbImportAt'] as int?;
    l.lbLastSync = j['lbLastSync'] as int?;
    l.lbSeen = ((j['lbSeen'] as Map?) ?? const {}).map((k, v) => MapEntry(k as String, v as String));
    l.lbGap = j['lbGap'] == true;
    l.unmatched = [for (final u in (j['unmatched'] as List? ?? const [])) u as String];
    return l;
  }
}
