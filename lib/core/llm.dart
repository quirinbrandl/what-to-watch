import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

class LlmException implements Exception {
  final String code;
  final String message;
  final int? status;
  LlmException(this.code, this.message, [this.status]);

  bool get usageLimit => code == 'subscription_sharing_usage_limit_exceeded' || code == 'insufficient_quota' || code == 'rate_limit_exceeded';
  bool get needsSignIn => status == 401 || code == 'signed_out' || code == 'session_expired' || code == 'subscription_sharing_invalid_user';
  bool get notEligible => code == 'subscription_sharing_user_not_eligible';
  bool get transient =>
      status == 503 || status == 502 || status == 500 || code == 'interrupted' || code == 'network' || code.endsWith('_unavailable');

  /// Short, credential-free text for the UI.
  String get friendly {
    if (usageLimit) return 'ChatGPT usage limit reached.';
    if (needsSignIn) return 'Please sign in again.';
    if (notEligible) return 'Your ChatGPT plan cannot be used in apps.';
    if (code == 'network') return 'No connection.';
    if (code == 'model_not_found') return 'That model is not available. Pick another in Settings.';
    return 'ChatGPT is not available right now.';
  }

  @override
  String toString() => 'LlmException($code, $status)';
}

class LlmModel {
  final String slug;
  final String name;
  const LlmModel(this.slug, this.name);
}

/// Minimal client for the OpenAI Responses API. Works with a ChatGPT-plan
/// access token (Sign in with ChatGPT) or a regular API key; both require
/// nothing beyond `store: false` + `stream: true` here.
class Llm {
  static const _base = 'https://api.openai.com/v1';
  final http.Client _http;
  final Future<String> Function() token;
  int calls = 0, chars = 0;

  Llm(this.token, [http.Client? client]) : _http = client ?? http.Client();

  Future<List<LlmModel>> models() async {
    final r = await _http.get(Uri.parse('$_base/models'), headers: {'Authorization': 'Bearer ${await token()}'}).timeout(const Duration(seconds: 20));
    if (r.statusCode != 200) throw _error(r.statusCode, utf8.decode(r.bodyBytes));
    final j = jsonDecode(utf8.decode(r.bodyBytes)) as Map;
    if (j['models'] is List) {
      // ChatGPT plan: keep the server's order, show only listed models.
      return [
        for (final m in j['models'] as List)
          if (m is Map && m['visibility'] == 'list' && m['slug'] is String) LlmModel(m['slug'] as String, (m['display_name'] ?? m['slug']) as String)
      ];
    }
    // API key: plain model ids; keep general text models, newest first.
    final skip = RegExp(r'audio|realtime|image|tts|transcribe|embedding|moderation|whisper|dall|search|codex|instruct|babbage|davinci|sora|computer');
    final data = [for (final m in (j['data'] as List? ?? const [])) if (m is Map && m['id'] is String && !skip.hasMatch(m['id'] as String)) m]
      ..sort((a, b) => ((b['created'] as num?) ?? 0).compareTo((a['created'] as num?) ?? 0));
    return [for (final m in data) LlmModel(m['id'] as String, m['id'] as String)];
  }

  /// One streamed response; returns the complete output text.
  /// [effort] is the reasoning effort ("low" | "medium" | "high"); models
  /// that do not accept it are retried without.
  Future<String> respond({
    required String model,
    required String developer,
    required String user,
    String? effort,
    void Function(int chars)? onProgress,
    int retries = 1,
  }) async {
    for (var attempt = 0;; attempt++) {
      try {
        return await _once(model, developer, user, effort, onProgress);
      } on LlmException catch (e) {
        if (e.status == 400 && effort != null && e.message.toLowerCase().contains('reasoning')) {
          effort = null;
          continue;
        }
        if (!e.transient || attempt >= retries) rethrow;
        await Future<void>.delayed(Duration(seconds: 2 + attempt * 3));
      }
    }
  }

  Future<String> _once(String model, String developer, String user, String? effort, void Function(int)? onProgress) async {
    final req = http.Request('POST', Uri.parse('$_base/responses'))
      ..headers['Authorization'] = 'Bearer ${await token()}'
      ..headers['Content-Type'] = 'application/json'
      ..headers['Accept'] = 'text/event-stream'
      ..body = jsonEncode({
        'model': model,
        'input': [
          {'role': 'developer', 'content': developer},
          {'role': 'user', 'content': user},
        ],
        'store': false,
        'stream': true,
        if (effort != null) 'reasoning': {'effort': effort},
      });
    calls++;
    final http.StreamedResponse res;
    try {
      res = await _http.send(req).timeout(const Duration(seconds: 60));
    } on TimeoutException {
      throw LlmException('network', 'timeout');
    } catch (_) {
      throw LlmException('network', 'connection failed');
    }
    if (res.statusCode != 200) {
      throw _error(res.statusCode, await res.stream.bytesToString().timeout(const Duration(seconds: 20), onTimeout: () => ''));
    }
    final out = StringBuffer();
    var completed = false;
    try {
      await for (final line in res.stream.transform(utf8.decoder).transform(const LineSplitter()).timeout(const Duration(seconds: 180))) {
        if (!line.startsWith('data:')) continue;
        final data = line.substring(5).trim();
        if (data.isEmpty || data == '[DONE]') continue;
        final Map ev;
        try {
          ev = jsonDecode(data) as Map;
        } catch (_) {
          continue;
        }
        switch (ev['type']) {
          case 'response.output_text.delta':
            out.write(ev['delta'] ?? '');
            onProgress?.call(out.length);
          case 'response.completed':
            completed = true;
            if (out.isEmpty) out.write(_outputText(ev['response']));
          case 'response.failed':
            final err = (ev['response'] as Map?)?['error'] as Map?;
            throw LlmException('${err?['code'] ?? 'unknown_error'}', '${err?['message'] ?? 'failed'}');
          case 'response.incomplete':
            throw LlmException('incomplete', '${((ev['response'] as Map?)?['incomplete_details'] as Map?)?['reason'] ?? 'incomplete'}');
          case 'error':
            throw LlmException('${ev['code'] ?? (ev['error'] as Map?)?['code'] ?? 'unknown_error'}', '${ev['message'] ?? 'error'}');
        }
      }
    } on LlmException {
      rethrow;
    } catch (_) {
      throw LlmException('interrupted', 'stream interrupted');
    }
    if (!completed) throw LlmException('interrupted', 'stream ended early');
    chars += out.length;
    return out.toString();
  }

  static String _outputText(dynamic response) {
    final sb = StringBuffer();
    for (final item in ((response as Map?)?['output'] as List? ?? const [])) {
      for (final c in ((item as Map)['content'] as List? ?? const [])) {
        if (c is Map && c['type'] == 'output_text') sb.write(c['text'] ?? '');
      }
    }
    return sb.toString();
  }

  static LlmException _error(int status, String body) {
    var code = 'http_$status', message = 'HTTP $status';
    try {
      final e = (jsonDecode(body) as Map)['error'];
      if (e is Map) {
        code = '${e['code'] ?? e['type'] ?? code}';
        message = '${e['message'] ?? message}';
      } else if (e is String) {
        code = e;
      }
    } catch (_) {}
    return LlmException(code, message, status);
  }
}

/// Pulls the first JSON object out of model output (tolerates code fences
/// and stray prose).
Map<String, dynamic>? extractJson(String text) {
  final a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return (jsonDecode(text.substring(a, b + 1)) as Map).cast<String, dynamic>();
  } catch (_) {
    return null;
  }
}

/// Parses JSON Lines output, skipping anything that is not a JSON object.
List<Map<String, dynamic>> extractJsonLines(String text) {
  final out = <Map<String, dynamic>>[];
  for (var line in const LineSplitter().convert(text)) {
    line = line.trim();
    if (line.endsWith(',')) line = line.substring(0, line.length - 1);
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      out.add((jsonDecode(line) as Map).cast<String, dynamic>());
    } catch (_) {}
  }
  return out;
}
