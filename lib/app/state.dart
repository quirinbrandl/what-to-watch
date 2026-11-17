import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:path_provider/path_provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/auth.dart';
import '../core/engine/recommender.dart';
import '../core/engine/request.dart';
import '../core/letterboxd.dart';
import '../core/llm.dart';
import '../core/models.dart';
import '../core/store.dart';
import '../core/tmdb.dart';

class _Secure implements SecretStore {
  final _s = const FlutterSecureStorage();
  @override
  Future<String?> read(String key) async {
    try {
      return await _s.read(key: key);
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> write(String key, String? value) => value == null ? _s.delete(key: key) : _s.write(key: key, value: value);
}

class Settings {
  String region = 'US';
  Map<int, String> providers = {}; // my streaming services: id -> name
  Map<int, String?> providerLogos = {};
  String? model;
  bool useApiKey = false;
  bool onboarded = false;
  bool welcomeSeen = false;
  bool flipHintSeen = false;
  Request request = Request();

  Map<String, dynamic> toJson() => {
        'region': region,
        'providers': [for (final e in providers.entries) [e.key, e.value, providerLogos[e.key]]],
        'model': model,
        'useApiKey': useApiKey,
        'onboarded': onboarded,
        'welcomeSeen': welcomeSeen,
        'flipHintSeen': flipHintSeen,
        'request': request.toJson(),
      };

  static Settings fromJson(Map<String, dynamic> j) {
    final s = Settings()
      ..region = (j['region'] ?? 'US') as String
      ..model = j['model'] as String?
      ..useApiKey = j['useApiKey'] == true
      ..onboarded = j['onboarded'] == true
      ..welcomeSeen = j['welcomeSeen'] == true
      ..flipHintSeen = j['flipHintSeen'] == true;
    for (final p in (j['providers'] as List? ?? const [])) {
      s.providers[p[0] as int] = p[1] as String;
      s.providerLogos[p[0] as int] = p[2] as String?;
    }
    if (j['request'] is Map) s.request = Request.fromJson((j['request'] as Map).cast<String, dynamic>());
    return s;
  }
}

class ImportProgress {
  final String label;
  final int done, total;
  final List<Film> posters;
  const ImportProgress(this.label, this.done, this.total, this.posters);
}

/// App-wide state: library, settings, accounts and the services built on
/// them. Everything is stored on the device.
class AppState extends ChangeNotifier {
  final films = FilmCache();
  final lib = Library();
  var settings = Settings();
  late final Tmdb tmdb = Tmdb(films);
  late final ChatGptAuth auth = ChatGptAuth(_secure);
  late final Llm llm = Llm(_token);
  late final Recommender rec = Recommender(tmdb, llm, lib, services, EngineConfig(''));
  final _secure = _Secure();
  late String _dir;
  bool ready = false;
  String? apiKey;
  List<LlmModel> models = [];
  ImportProgress? importing;
  bool syncing = false;
  String? syncError;
  int lastSyncAdded = 0;
  Timer? _saveTimer, _filmTimer;

  Services get services => Services(settings.region, settings.providers);
  bool get hasLlm => settings.useApiKey ? apiKey != null : auth.signedIn;
  String? get accountLabel => settings.useApiKey ? (apiKey != null ? 'OpenAI API key' : null) : auth.email;

  JsonFile _file(String name) => JsonFile('$_dir/$name.json');

  Future<void> init() async {
    _dir = (await getApplicationSupportDirectory()).path;
    final s = await _file('settings').read();
    if (s != null) {
      settings = Settings.fromJson(s);
    } else {
      final cc = PlatformDispatcher.instance.locale.countryCode;
      if (cc != null && cc.length == 2) settings.region = cc.toUpperCase();
    }
    final l = await _file('library').read();
    if (l != null) _replaceLibrary(Library.fromJson(l));
    final f = await _file('films').read();
    if (f != null) films.load(f);
    await auth.load();
    apiKey = await _secure.read('openai_api_key');
    rec.sv = services;
    ready = true;
    notifyListeners();
    unawaited(syncLetterboxd());
    if (hasLlm) unawaited(loadModels());
  }

  void _replaceLibrary(Library n) {
    lib.entries
      ..clear()
      ..addAll(n.entries);
    lib
      ..lbUsername = n.lbUsername
      ..lbImportAt = n.lbImportAt
      ..lbLastSync = n.lbLastSync
      ..lbSeen = n.lbSeen
      ..lbGap = n.lbGap
      ..unmatched = n.unmatched
      ..touch();
  }

  /// Something changed: repaint and persist soon.
  void changed({bool filmsToo = false}) {
    notifyListeners();
    _saveTimer?.cancel();
    _saveTimer = Timer(const Duration(milliseconds: 600), () {
      _file('library').write(lib.toJson());
      _file('settings').write(settings.toJson());
    });
    if (filmsToo) saveFilms();
  }

  void saveFilms() {
    _filmTimer?.cancel();
    _filmTimer = Timer(const Duration(seconds: 3), () {
      films.prune(lib.entries.keys.toSet());
      _file('films').write(films.toJson());
    });
  }

  Future<Map<String, dynamic>?> readSession() => _file('session').read();
  Future<void> writeSession(Map<String, dynamic>? j) => j == null ? _file('session').delete() : _file('session').write(j);

  // ------------------------------------------------------------ LLM access

  Future<String> _token() async {
    if (settings.useApiKey) {
      if (apiKey == null) throw LlmException('signed_out', 'no key');
      return apiKey!;
    }
    try {
      return await auth.accessToken();
    } on AuthException catch (e) {
      if (e.code == 'session_expired') notifyListeners();
      throw LlmException(e.code == 'network' || e.code == 'refresh' ? 'network' : 'signed_out', e.message);
    }
  }

  Future<void> signIn() async {
    await auth.signIn(
      returnUrl: 'whattowatch://auth',
      openBrowser: (url) async {
        if (!await launchUrl(url, mode: LaunchMode.inAppBrowserView)) {
          await launchUrl(url, mode: LaunchMode.externalApplication);
        }
      },
    );
    settings.useApiKey = false;
    changed();
    unawaited(loadModels());
  }

  /// Returns false when ChatGPT could not confirm the revocation.
  Future<bool> signOut() async {
    final ok = await auth.signOut();
    models = [];
    changed();
    return ok;
  }

  /// Stores (or with null removes) an OpenAI API key; verifies it first.
  Future<void> setApiKey(String? key) async {
    if (key == null) {
      apiKey = null;
      await _secure.write('openai_api_key', null);
      settings.useApiKey = false;
      models = [];
      changed();
      if (hasLlm) unawaited(loadModels());
      return;
    }
    final list = await Llm(() async => key).models(); // throws when the key is bad
    apiKey = key;
    await _secure.write('openai_api_key', key);
    settings
      ..useApiKey = true
      ..model = null;
    models = list;
    changed();
  }

  Future<void> loadModels() async {
    try {
      models = await llm.models();
      if (settings.model != null && !models.any((m) => m.slug == settings.model)) settings.model = null;
      notifyListeners();
    } catch (_) {}
  }

  /// The model to use: the user's choice, else the account's first listed.
  Future<String> model() async {
    if (settings.model != null) return settings.model!;
    if (models.isEmpty) models = await llm.models();
    if (models.isEmpty) throw LlmException('model_not_found', 'no models');
    return models.first.slug;
  }

  // ------------------------------------------------------------ library

  Film? film(int id) => films[id];

  void rate(int id, double? stars) {
    lib.rate(id, stars);
    changed();
  }

  void setWatched(int id, bool v) {
    lib.setWatched(id, v);
    changed();
  }

  void setWatchlist(int id, bool v) {
    lib.setWatchlist(id, v);
    changed();
  }

  void setNotInterested(int id, bool v) {
    lib.setNotInterested(id, v);
    changed();
  }

  /// Makes sure a film has full details (needed before it enters the library).
  Future<Film?> ensureFilm(int id) async {
    try {
      final f = await tmdb.details(id, settings.region);
      saveFilms();
      return f;
    } catch (_) {
      return films[id];
    }
  }

  // ------------------------------------------------------------ Letterboxd

  Future<void> importZip(Uint8List bytes) async {
    final ex = parseLetterboxdZip(bytes);
    final posters = <Film>[];
    void progress(String label, int done, int total) {
      importing = ImportProgress(label, done, total, List.of(posters));
      notifyListeners();
    }

    try {
      progress('Matching', 0, ex.films.length);
      await matchExport(ex, tmdb, onProgress: (done, total, f) {
        if (f?.poster != null && posters.length < 60) posters.add(f!);
        if (done % 4 == 0 || done == total) progress('Matching', done, total);
      });
      applyExport(lib, ex);
      rec.sv = services;
      await rec.ensureLibraryDetails(onProgress: (d, t) {
        if (d % 6 == 0 || d == t) progress('Reading your taste', d, t);
      });
    } finally {
      importing = null;
      changed(filmsToo: true);
    }
    unawaited(syncLetterboxd());
  }

  void setUsername(String? name) {
    lib.lbUsername = name == null ? null : cleanUsername(name);
    syncError = null;
    changed();
    if (lib.lbUsername != null) unawaited(syncLetterboxd());
  }

  /// Checks the Letterboxd RSS feed and merges anything new. Runs on every
  /// app start, on resume and on pull-to-refresh.
  Future<void> syncLetterboxd() async {
    final user = lib.lbUsername;
    if (user == null || syncing) return;
    syncing = true;
    syncError = null;
    notifyListeners();
    try {
      final items = await fetchRss(user);
      final res = applyRss(lib, items);
      lastSyncAdded = res.added + res.updated;
      if (res.ids.isNotEmpty) await tmdb.detailsAll(res.ids, settings.region, providerMaxAgeDays: 36500);
      await rec.ensureLibraryDetails();
    } on LbNotFound {
      syncError = 'No Letterboxd profile named "$user".';
    } catch (_) {
      syncError = 'Letterboxd could not be reached.';
    } finally {
      syncing = false;
      changed(filmsToo: true);
    }
  }

  // ------------------------------------------------------------ region

  Future<List<Prov>> providerCatalog() => tmdb.providerCatalog(settings.region);

  void setRegion(String region) {
    if (region == settings.region) return;
    settings
      ..region = region
      ..providers = {}
      ..providerLogos = {};
    rec.sv = services;
    changed();
  }

  void toggleProvider(Prov p) {
    if (settings.providers.remove(p.id) == null) {
      settings.providers[p.id] = p.name;
      settings.providerLogos[p.id] = p.logo;
    } else {
      settings.providerLogos.remove(p.id);
    }
    rec.sv = services;
    changed();
  }

  // ------------------------------------------------------------ data

  /// Backup of library and settings. Contains no credentials.
  Uint8List backupBytes() => Uint8List.fromList(utf8.encode(jsonEncode({
        'app': 'what-to-watch',
        'version': 1,
        'exportedAt': DateTime.now().toUtc().toIso8601String(),
        'library': lib.toJson(),
        'settings': settings.toJson(),
      })));

  Future<void> restore(Uint8List bytes) async {
    final Map<String, dynamic> j;
    try {
      j = (jsonDecode(utf8.decode(bytes)) as Map).cast<String, dynamic>();
    } catch (_) {
      throw const FormatException('Not a backup file.');
    }
    if (j['app'] != 'what-to-watch' || j['library'] is! Map) throw const FormatException('Not a What to Watch backup.');
    _replaceLibrary(Library.fromJson((j['library'] as Map).cast<String, dynamic>()));
    if (j['settings'] is Map) {
      final keep = settings;
      settings = Settings.fromJson((j['settings'] as Map).cast<String, dynamic>())
        ..onboarded = true
        ..useApiKey = keep.useApiKey
        ..welcomeSeen = keep.welcomeSeen;
    }
    rec.sv = services;
    changed();
    await rec.ensureLibraryDetails();
    changed(filmsToo: true);
    unawaited(syncLetterboxd());
  }

  Future<void> deleteAll() async {
    _saveTimer?.cancel();
    _filmTimer?.cancel();
    try {
      await auth.signOut();
    } catch (_) {}
    await auth.wipe();
    await _secure.write('openai_api_key', null);
    apiKey = null;
    models = [];
    _replaceLibrary(Library());
    films.films.clear();
    settings = Settings();
    final cc = PlatformDispatcher.instance.locale.countryCode;
    if (cc != null && cc.length == 2) settings.region = cc.toUpperCase();
    rec.sv = services;
    for (final n in ['library', 'settings', 'films', 'session']) {
      await _file(n).delete();
    }
    try {
      final cache = await getTemporaryDirectory();
      if (await cache.exists()) {
        await for (final e in cache.list()) {
          await e.delete(recursive: true);
        }
      }
    } catch (_) {}
    notifyListeners();
  }
}

final app = AppState();

/// ISO 3166 regions where TMDB has watch-provider data, by display name.
const kRegions = {
  'AR': 'Argentina', 'AU': 'Australia', 'AT': 'Austria', 'BE': 'Belgium', 'BR': 'Brazil', 'CA': 'Canada', 'CL': 'Chile',
  'CO': 'Colombia', 'CZ': 'Czechia', 'DK': 'Denmark', 'FI': 'Finland', 'FR': 'France', 'DE': 'Germany', 'GR': 'Greece',
  'HK': 'Hong Kong', 'HU': 'Hungary', 'IN': 'India', 'ID': 'Indonesia', 'IE': 'Ireland', 'IL': 'Israel', 'IT': 'Italy',
  'JP': 'Japan', 'MX': 'Mexico', 'NL': 'Netherlands', 'NZ': 'New Zealand', 'NO': 'Norway', 'PH': 'Philippines', 'PL': 'Poland',
  'PT': 'Portugal', 'RO': 'Romania', 'SG': 'Singapore', 'ZA': 'South Africa', 'KR': 'South Korea', 'ES': 'Spain', 'SE': 'Sweden',
  'CH': 'Switzerland', 'TW': 'Taiwan', 'TH': 'Thailand', 'TR': 'Türkiye', 'GB': 'United Kingdom', 'US': 'United States',
};
