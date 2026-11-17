// LLM-backed evaluation modes. Uses OPENAI_API_KEY when set, otherwise a
// "Sign in with ChatGPT" session stored outside the repository
// (~/.config/what-to-watch/eval-credentials.json, owner-only).
import 'dart:convert';
import 'dart:io';

import 'package:what_to_watch/core/auth.dart';
import 'package:what_to_watch/core/engine/prompts.dart';
import 'package:what_to_watch/core/engine/recommender.dart';
import 'package:what_to_watch/core/engine/request.dart';
import 'package:what_to_watch/core/letterboxd.dart';
import 'package:what_to_watch/core/llm.dart';
import 'package:what_to_watch/core/models.dart';
import 'package:what_to_watch/core/store.dart';

import 'eval_common.dart';

class FileSecretStore implements SecretStore {
  final File file = File('${Platform.environment['HOME']}/.config/what-to-watch/eval-credentials.json');
  Map<String, dynamic> _data = {};
  bool _loaded = false;

  void _load() {
    if (_loaded) return;
    _loaded = true;
    if (file.existsSync()) _data = (jsonDecode(file.readAsStringSync()) as Map).cast<String, dynamic>();
  }

  @override
  Future<String?> read(String key) async {
    _load();
    return _data[key] as String?;
  }

  @override
  Future<void> write(String key, String? value) async {
    _load();
    value == null ? _data.remove(key) : _data[key] = value;
    file.parent.createSync(recursive: true);
    final tmp = File('${file.path}.tmp')..writeAsStringSync(jsonEncode(_data), flush: true);
    Process.runSync('chmod', ['600', tmp.path]);
    tmp.renameSync(file.path);
  }
}

/// Signs the eval CLI in. With [adb], the browser step happens on the
/// connected Android device/emulator (its loopback is forwarded to this Mac).
Future<void> evalSignIn({bool adb = false}) async {
  final auth = ChatGptAuth(FileSecretStore());
  await auth.load();
  await auth.signIn(openBrowser: (url) async {
    if (adb) {
      final port = Uri.parse(url.queryParameters['redirect_uri']!).port;
      final sdk = '${Platform.environment['HOME']}/Library/Android/sdk/platform-tools/adb';
      Process.runSync(sdk, ['reverse', 'tcp:$port', 'tcp:$port']);
      Process.runSync(sdk, ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', "'$url'"]);
      stderr.writeln('Opened the sign-in page on the Android device (port $port).');
    } else {
      stderr.writeln('Opening the browser to sign in…');
      Process.runSync('open', [url.toString()]);
    }
  });
  stdout.writeln('Signed in as ${auth.email}.');
}

Future<(Llm, String)> _llm(String? model) async {
  final key = Platform.environment['OPENAI_API_KEY'];
  final Llm llm;
  if (key != null && key.isNotEmpty) {
    llm = Llm(() async => key);
  } else {
    final auth = ChatGptAuth(FileSecretStore());
    await auth.load();
    if (!auth.signedIn) {
      stderr.writeln('No LLM access. Run `dart run tool/eval.dart signin` or set OPENAI_API_KEY.');
      exit(2);
    }
    llm = Llm(auth.accessToken);
  }
  final models = await llm.models();
  stdout.writeln('Models: ${models.map((m) => m.slug).join(', ')}');
  final slug = model ?? models.first.slug;
  stdout.writeln('Using: $slug');
  return (llm, slug);
}

Library _without(Library lib, Iterable<int> ids) {
  final copy = Library.fromJson(lib.toJson());
  for (final id in ids) {
    copy.entries.remove(id);
  }
  return copy;
}

/// Held-out rating prediction by the LLM judge, alone and blended with the
/// local taste model. One LLM call per fold; verdicts are cached.
Future<void> evalJudge(EvalData d, {String? model, int folds = 5}) async {
  final (llm, slug) = await _llm(model);
  final sv = const Services('DE');
  final names = ['TMDB score (baseline)', 'taste model', 'LLM judge', 'blend 40% judge', 'blend 60% judge', 'blend 80% judge'];
  final reports = {for (final n in names) n: <Fold>[]};
  var whyOk = 0, whyAll = 0, missing = 0;
  final split = kfold(d.lib).take(folds).toList();
  for (var i = 0; i < split.length; i++) {
    final fold = split[i];
    final lib = _without(d.lib, fold);
    final rec = Recommender(d.tmdb, llm, lib, sv, EngineConfig(slug));
    final m = rec.model();
    final brief = tasteBrief(lib, d.films, m, tagged: true, listSeen: false);
    final cands = [for (final id in fold) if (d.films[id] != null) d.films[id]!];
    final cache = JsonFile('$cacheDir/judge_${slug}_$i.json');
    var raw = await cache.read();
    if (raw == null) {
      final sw = Stopwatch()..start();
      final v = await rec.judge(cands, brief: brief, request: requestBrief(Request(), sv));
      stderr.writeln('fold ${i + 1}/${split.length}: ${v.length}/${cands.length} verdicts in ${sw.elapsed.inSeconds}s');
      raw = {for (final e in v.entries) '${e.key}': {'r': e.value.r, 'm': e.value.m, 'why': e.value.why}};
      await cache.write(raw);
    }
    final fs = {for (final n in names) n: Fold()};
    for (final f in cands) {
      final y = d.lib[f.id]!.rating!;
      final local = m.predict(f).rating;
      final v = raw['${f.id}'] as Map?;
      if (v == null) missing++;
      final j = (v?['r'] as num?)?.toDouble() ?? local;
      if (v != null) {
        whyAll++;
        if (validateWhy(v['why'] as String, brief.tags, lib, d.films) != null) whyOk++;
      }
      void add(String n, double p) => fs[n]!
        ..pred.add(p)
        ..y.add(y);
      add(names[0], f.score);
      add(names[1], local);
      add(names[2], j);
      add(names[3], 0.4 * j + 0.6 * local);
      add(names[4], 0.6 * j + 0.4 * local);
      add(names[5], 0.8 * j + 0.2 * local);
    }
    for (final n in names) {
      reports[n]!.add(fs[n]!);
    }
  }
  stdout.writeln('\n${split.length}-fold hold-out, LLM judge ($slug)\n${Report.header()}');
  for (final n in names) {
    stdout.writeln(Report.of(n, reports[n]!));
  }
  stdout.writeln('\nExplanations passing validation: $whyOk/$whyAll · candidates without verdict: $missing');
  stdout.writeln('LLM calls: ${llm.calls}, output chars: ${llm.chars}');
}

/// Blind rediscovery: hide a fold of ratings completely, run the full
/// pipeline with no request, and look at the films it brings back that the
/// user had in fact already seen and rated.
Future<void> evalBlind(EvalData d, {String? model, int folds = 2}) async {
  final (llm, slug) = await _llm(model);
  final split = kfold(d.lib).take(folds).toList();
  final idea = <double>[], judged = <double>[], top = <double>[], dropped = <double>[], base = <double>[];
  for (var i = 0; i < split.length; i++) {
    final fold = split[i].toSet();
    base.addAll(fold.map((id) => d.lib[id]!.rating!));
    final lib = _without(d.lib, fold);
    final rec = Recommender(d.tmdb, llm, lib, const Services('DE'), EngineConfig(slug, batch: 12));
    final sw = Stopwatch()..start();
    final s = await rec.start(Request(), onProgress: (_) {});
    stderr.writeln('fold ${i + 1}: ${s.picks.length} picks, ${s.reserve.length} in reserve, ${sw.elapsed.inSeconds}s${s.notice == null ? '' : ' · ${s.notice}'}');
    for (final t in s.suggested) {
      final m = RegExp(r'^(.*) \((\d{4})\)$').firstMatch(t);
      final f = await matchTitle(d.tmdb, m?[1] ?? t, int.tryParse(m?[2] ?? ''));
      if (f != null && fold.contains(f.id)) idea.add(d.lib[f.id]!.rating!);
    }
    final kept = {for (final p in [...s.picks, ...s.reserve]) p.film.id};
    judged.addAll(kept.where(fold.contains).map((id) => d.lib[id]!.rating!));
    top.addAll(s.picks.map((p) => p.film.id).where(fold.contains).map((id) => d.lib[id]!.rating!));
    dropped.addAll(s.seen.where((id) => fold.contains(id) && !kept.contains(id)).map((id) => d.lib[id]!.rating!));
    stdout.writeln('  top picks: ${s.picks.map((p) => '${p.film.title}${fold.contains(p.film.id) ? ' [★${d.lib[p.film.id]!.rating}]' : ''}').join(' · ')}');
  }
  await d.save();
  String line(String name, List<double> v) => v.isEmpty
      ? '${name.padRight(44)} n=0'
      : '${name.padRight(44)} n=${v.length.toString().padLeft(3)}  ≥3★ ${(v.where((x) => x >= 3).length / v.length * 100).toStringAsFixed(0).padLeft(3)}%  ≥4★ ${(v.where((x) => x >= 4).length / v.length * 100).toStringAsFixed(0).padLeft(3)}%  mean ${(v.reduce((a, b) => a + b) / v.length).toStringAsFixed(2)}';
  stdout.writeln('\nBlind rediscovery ($slug, ${split.length} folds) — true ratings of hidden films the engine brought back');
  stdout.writeln(line('hidden films overall (base rate)', base));
  stdout.writeln(line('proposed by LLM scouting', idea));
  stdout.writeln(line('survived judging (picks + reserve)', judged));
  stdout.writeln(line('in the first batch of 12', top));
  stdout.writeln(line('rejected by the judge (predicted < 3★)', dropped));
  stdout.writeln('LLM calls: ${llm.calls}');
}
