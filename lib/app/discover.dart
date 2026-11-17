import 'package:flutter/foundation.dart';

import '../core/engine/recommender.dart';
import '../core/engine/request.dart';
import '../core/llm.dart';
import '../core/models.dart';
import '../core/tmdb.dart';
import 'state.dart';

/// Drives one discovery session for the UI.
class Discover extends ChangeNotifier {
  Session? session;
  bool running = false;
  bool loadingMore = false;
  Stage? stage;
  int pool = 0;
  final List<Film> scouted = [];
  String? error;
  LlmException? llmError;
  int _run = 0;

  Request get request => app.settings.request;

  Future<void> restore() async {
    try {
      final j = await app.readSession();
      if (j != null) {
        final s = Session.fromJson(j, app.films);
        if (s.picks.isNotEmpty) session = s;
      }
    } catch (_) {}
    notifyListeners();
  }

  /// Starts a fresh session from the current request, or "more like" [seed].
  Future<void> start({Film? seed}) async {
    final r = request.copy();
    if (seed != null) {
      r
        ..seedId = seed.id
        ..prompt = '';
    }
    session = null;
    await _go((run) async {
      final s = await app.rec.start(r, onProgress: (p) => _progress(run, p));
      if (run == _run) session = s;
    });
  }

  Future<void> more() async {
    final s = session;
    if (s == null || running) return;
    loadingMore = true;
    await _go((run) => app.rec.more(s, onProgress: (p) => _progress(run, p)));
    loadingMore = false;
    notifyListeners();
  }

  void cancel() {
    _run++;
    running = false;
    loadingMore = false;
    stage = null;
    notifyListeners();
  }

  void remove(Pick p) {
    session?.picks.remove(p);
    notifyListeners();
    _persist();
  }

  void _progress(int run, Progress p) {
    if (run != _run) return;
    stage = p.stage;
    pool = p.pool;
    if (scouted.length < 150) scouted.addAll(p.posters.take(150 - scouted.length));
    notifyListeners();
  }

  Future<void> _go(Future<void> Function(int run) job) async {
    if (running) return;
    final run = ++_run;
    running = true;
    error = null;
    llmError = null;
    stage = Stage.taste;
    pool = 0;
    scouted.clear();
    notifyListeners();
    try {
      app.rec.cfg.model = await app.model();
      await job(run);
    } on LlmException catch (e) {
      if (run == _run) {
        llmError = e;
        error = e.friendly;
      }
    } on TmdbException {
      if (run == _run) error = 'Film data could not be loaded.';
    } catch (_) {
      if (run == _run) error = 'Something went wrong.';
    } finally {
      if (run == _run) {
        running = false;
        stage = null;
        notifyListeners();
        _persist();
        app.saveFilms();
      }
    }
  }

  void _persist() => app.writeSession(session?.toJson());

  void clear() {
    session = null;
    app.writeSession(null);
    notifyListeners();
  }
}

final discover = Discover();
