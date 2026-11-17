import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;
import 'package:pointycastle/export.dart' as pc;

import 'models.dart';

/// Where credentials live (Android Keystore / iOS Keychain in the app, an
/// owner-only file for the eval CLI). Values never reach logs or backups.
abstract class SecretStore {
  Future<String?> read(String key);
  Future<void> write(String key, String? value);
}

class AuthException implements Exception {
  final String code;
  final String message;
  AuthException(this.code, this.message);
  @override
  String toString() => message;
}

/// "Sign in with ChatGPT" for open-source apps: OAuth 2 authorization code
/// with PKCE on a loopback redirect, dynamic client registration on first
/// sign-in, rotating refresh tokens.
/// https://developers.openai.com/siwc/token-sharing-open-source
class ChatGptAuth {
  static const _authorize = 'https://auth.openai.com/api/accounts/authorize';
  static const _token = 'https://auth.openai.com/api/accounts/oauth/token';
  static const _revokeFallback = 'https://auth.openai.com/api/accounts/oauth/revoke';
  static const _discovery = 'https://auth.openai.com/.well-known/openid-configuration';
  static const _jwks = 'https://auth.openai.com/.well-known/jwks.json';
  static const _issuer = 'https://auth.openai.com';
  static const _scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
  static const _resource = 'https://api.openai.com/v1';
  static const _kHost = 'chatgpt_host_id', _kClient = 'chatgpt_client', _kCred = 'chatgpt_cred';
  static const _terminal = {
    'invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused',
  };

  final SecretStore store;
  final String appName;
  final http.Client _http;
  Map<String, dynamic>? _cred;
  Map<String, dynamic>? _client; // {client_id, subject, email}: survives sign-out
  HttpServer? _server;
  Completer<Uri>? _pending;
  Future<String>? _refreshing;

  ChatGptAuth(this.store, {this.appName = 'What to Watch', http.Client? client}) : _http = client ?? http.Client();

  bool get signedIn => _cred != null;
  String? get email => _cred?['email'] as String?;
  bool get signingIn => _pending != null;

  Future<void> load() async {
    _cred = _decode(await store.read(_kCred));
    _client = _decode(await store.read(_kClient));
  }

  static Map<String, dynamic>? _decode(String? s) {
    if (s == null) return null;
    try {
      return (jsonDecode(s) as Map).cast<String, dynamic>();
    } catch (_) {
      return null;
    }
  }

  static final _rnd = Random.secure();
  static String _random(int bytes) => base64UrlEncode(List.generate(bytes, (_) => _rnd.nextInt(256))).replaceAll('=', '');

  static String _uuid() {
    final b = List.generate(16, (_) => _rnd.nextInt(256));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
    return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
  }

  /// Runs the browser sign-in. [openBrowser] must open the URL in the system
  /// browser. [returnUrl] is an app link the "done" page jumps to, bringing
  /// the app back to the foreground.
  Future<void> signIn({required Future<void> Function(Uri url) openBrowser, String? returnUrl, Duration timeout = const Duration(minutes: 10)}) async {
    cancelSignIn();
    var hostId = await store.read(_kHost);
    if (hostId == null) {
      hostId = 'urn:uuid:${_uuid()}';
      await store.write(_kHost, hostId);
    }
    final savedClient = _client?['client_id'] as String?;
    final state = _random(24), nonce = _random(24), verifier = _random(48);
    final challenge = base64UrlEncode(sha256.convert(ascii.encode(verifier)).bytes).replaceAll('=', '');

    final server = _server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final redirect = 'http://127.0.0.1:${server.port}/auth/callback';
    final pending = _pending = Completer<Uri>();
    server.listen((req) async {
      if (req.uri.path != '/auth/callback') {
        req.response.statusCode = 404;
        await req.response.close();
        return;
      }
      final ok = req.uri.queryParameters['error'] == null && req.uri.queryParameters['state'] == state;
      req.response.headers.contentType = ContentType.html;
      req.response.write(_donePage(ok, returnUrl));
      await req.response.close();
      if (!pending.isCompleted) pending.complete(req.uri);
    });

    try {
      await openBrowser(Uri.parse(_authorize).replace(queryParameters: {
        'client_id': savedClient ?? 'dynamic_agent_client',
        if (savedClient == null) 'agent_name_hint': appName,
        'ext_agent_host_id': hostId,
        'response_type': 'code',
        'redirect_uri': redirect,
        'scope': _scope,
        'resource': _resource,
        'state': state,
        'nonce': nonce,
        'code_challenge_method': 'S256',
        'code_challenge': challenge,
      }));
      final cb = await pending.future.timeout(timeout, onTimeout: () => throw AuthException('timeout', 'Sign-in timed out.'));
      final q = cb.queryParameters;
      if (q['state'] != state) throw AuthException('state', 'Sign-in could not be verified. Please try again.');
      if (q['error'] != null) {
        if (q['error'] == 'access_denied') throw AuthException('access_denied', 'Sign-in was cancelled.');
        // A stale registration can cause this; register afresh next time.
        _client = null;
        await store.write(_kClient, null);
        throw AuthException(q['error']!, 'ChatGPT sign-in failed. Please try again.');
      }
      final code = q['code'];
      final issued = q['client_id'];
      if (code == null) throw AuthException('no_code', 'Sign-in returned no authorization code.');
      if (savedClient == null && issued == null) throw AuthException('registration', 'Registration was incomplete. Please try again.');
      if (savedClient != null && issued != null && issued != savedClient) throw AuthException('client', 'Sign-in returned an unexpected client.');
      final clientId = savedClient ?? issued!;

      final r = await _http.post(Uri.parse(_token), body: {
        'grant_type': 'authorization_code',
        'client_id': clientId,
        'code': code,
        'code_verifier': verifier,
        'redirect_uri': redirect,
        'resource': _resource,
      }).timeout(const Duration(seconds: 30));
      final t = _decode(utf8.decode(r.bodyBytes));
      if (r.statusCode != 200 || t == null) {
        throw AuthException('${t?['error'] ?? 'token'}', 'ChatGPT did not complete the sign-in (${r.statusCode}).');
      }
      final idToken = t['id_token'] as String?;
      if (idToken == null) throw AuthException('id_token', 'Sign-in returned no identity.');
      final claims = await _validateIdToken(idToken, clientId, nonce);
      final scopes = ('${t['scope'] ?? q['scope'] ?? ''}').split(RegExp(r'[ +]')).where((s) => s.isNotEmpty).toList();
      if (!scopes.contains('chatgpt.tokens.use.direct')) {
        throw AuthException('scope', 'ChatGPT did not grant plan usage to this app.');
      }
      final prev = _client?['subject'];
      if (savedClient != null && prev != null && prev != claims['sub']) {
        _client = null;
        await store.write(_kClient, null);
        throw AuthException('account', 'That is a different ChatGPT account. Please sign in again.');
      }
      _client = {'client_id': clientId, 'subject': claims['sub'], 'email': claims['email']};
      await store.write(_kClient, jsonEncode(_client));
      await _saveTokens(t, base: {
        'email': claims['email'],
        'issuer': _issuer,
        'subject': claims['sub'],
        'client_id': clientId,
        'ext_agent_host_id': hostId,
        'id_token': idToken,
      });
    } finally {
      cancelSignIn();
    }
  }

  void cancelSignIn() {
    final p = _pending;
    _pending = null;
    if (p != null && !p.isCompleted) p.completeError(AuthException('access_denied', 'Sign-in was cancelled.'));
    // Let the "done" page finish sending before the listener goes away.
    final s = _server;
    _server = null;
    if (s != null) Future<void>.delayed(const Duration(seconds: 2), () => s.close(force: true));
  }

  static String _donePage(bool ok, String? returnUrl) => '<!doctype html><html><head><meta charset="utf-8">'
      '<meta name="viewport" content="width=device-width,initial-scale=1"><title>What to Watch</title></head>'
      '<body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;'
      'background:#0b0b0e;color:#f4f1ea;font:17px system-ui,sans-serif;text-align:center">'
      '<div style="font-size:52px">${ok ? '&#10003;' : '&#10005;'}</div>'
      '<div>${ok ? 'Signed in' : 'Sign-in was not completed'}</div>'
      '${returnUrl == null ? '<div style="opacity:.6">You can close this tab.</div>' : '<a href="$returnUrl" style="padding:14px 26px;border-radius:999px;background:#f4f1ea;color:#0b0b0e;text-decoration:none;font-weight:600">Back to What to Watch</a>'
          '<script>setTimeout(function(){location.href=${jsonEncode(returnUrl)}},120)</script>'}'
      '</body></html>';

  Future<void> _saveTokens(Map<String, dynamic> t, {Map<String, dynamic>? base}) async {
    final now = nowSec();
    final cred = {
      ...?(base ?? _cred),
      'access_token': t['access_token'],
      if (t['refresh_token'] != null) 'refresh_token': t['refresh_token'],
      if (t['id_token'] != null) 'id_token': t['id_token'],
      'token_type': t['token_type'] ?? 'Bearer',
      'expires_at': now + ((t['expires_in'] as num?)?.toInt() ?? 3600),
      'earliest_refresh_at': _epoch(t['earliest_refresh_at']),
      if (t['scope'] != null) 'scopes': '${t['scope']}'.split(' '),
      'saved_at': now,
    };
    if (cred['access_token'] == null || cred['refresh_token'] == null) {
      throw AuthException('token', 'ChatGPT returned an incomplete session.');
    }
    await store.write(_kCred, jsonEncode(cred)); // persist before first use: refresh tokens rotate
    _cred = cred;
  }

  static int? _epoch(dynamic v) {
    if (v is num) return v > 1e11 ? v ~/ 1000 : v.toInt();
    if (v is String) {
      final n = num.tryParse(v);
      if (n != null) return _epoch(n);
      final d = DateTime.tryParse(v);
      if (d != null) return d.millisecondsSinceEpoch ~/ 1000;
    }
    return null;
  }

  /// A valid access token, refreshed when it is about to expire. Refreshes
  /// are serialised so the rotating refresh token is never raced.
  Future<String> accessToken() {
    final c = _cred;
    if (c == null) return Future.error(AuthException('signed_out', 'Sign in with ChatGPT to continue.'));
    final now = nowSec();
    final exp = c['expires_at'] as int? ?? 0;
    if (now < exp - 90) return Future.value(c['access_token'] as String);
    final earliest = c['earliest_refresh_at'] as int?;
    if (earliest != null && now < earliest && now < exp - 5) return Future.value(c['access_token'] as String);
    return _refreshing ??= _refresh().whenComplete(() => _refreshing = null);
  }

  Future<String> _refresh() async {
    final c = _cred!;
    final http.Response r;
    try {
      r = await _http.post(Uri.parse(_token), body: {
        'grant_type': 'refresh_token',
        'client_id': c['client_id'],
        'refresh_token': c['refresh_token'],
        'resource': _resource,
      }).timeout(const Duration(seconds: 30));
    } catch (_) {
      throw AuthException('network', 'Could not reach ChatGPT. Check your connection.');
    }
    final t = _decode(utf8.decode(r.bodyBytes));
    if (r.statusCode == 200 && t != null) {
      await _saveTokens(t);
      return _cred!['access_token'] as String;
    }
    final err = '${t?['error'] is Map ? t!['error']['code'] : t?['error']}';
    if (_terminal.contains(err) || r.statusCode == 401) {
      await _clearTokens();
      throw AuthException('session_expired', 'Your ChatGPT session ended. Please sign in again.');
    }
    throw AuthException('refresh', 'ChatGPT is not reachable right now (${r.statusCode}).');
  }

  Future<void> _clearTokens() async {
    _cred = null;
    await store.write(_kCred, null);
  }

  /// Call when the API rejects the token outright (HTTP 401).
  Future<void> invalidate() => _clearTokens();

  /// Revokes the session and clears local tokens. Returns false when remote
  /// revocation could not be confirmed (tokens are cleared regardless).
  Future<bool> signOut() async {
    final c = _cred;
    if (c == null) return true;
    var confirmed = false;
    var endpoint = _revokeFallback;
    try {
      final d = _decode((await _http.get(Uri.parse(_discovery)).timeout(const Duration(seconds: 10))).body);
      final e = d?['revocation_endpoint'];
      if (e is String && e.startsWith('https://auth.openai.com/')) endpoint = e;
    } catch (_) {}
    for (var i = 0; i < 3 && !confirmed; i++) {
      try {
        final r = await _http.post(Uri.parse(endpoint), body: {
          'token': c['refresh_token'],
          'token_type_hint': 'refresh_token',
          'client_id': c['client_id'],
        }).timeout(const Duration(seconds: 15));
        if (r.statusCode == 200) confirmed = true;
        if (r.statusCode < 500) break;
      } catch (_) {}
      if (!confirmed) await Future<void>.delayed(Duration(milliseconds: 600 * (i + 1)));
    }
    await _clearTokens();
    return confirmed;
  }

  /// Forget everything, including the registration and host id.
  Future<void> wipe() async {
    _cred = null;
    _client = null;
    for (final k in [_kCred, _kClient, _kHost]) {
      await store.write(k, null);
    }
  }

  // ---- ID token (RS256 against OpenAI's JWKS)

  static Uint8List _b64(String s) => base64Url.decode(s.padRight((s.length + 3) ~/ 4 * 4, '='));
  static BigInt _big(Uint8List b) => b.fold(BigInt.zero, (a, x) => (a << 8) | BigInt.from(x));

  Future<Map<String, dynamic>> _validateIdToken(String jwt, String clientId, String nonce) async {
    final bad = AuthException('id_token', 'ChatGPT identity could not be verified.');
    final parts = jwt.split('.');
    if (parts.length != 3) throw bad;
    final Map<String, dynamic> header, claims;
    try {
      header = (jsonDecode(utf8.decode(_b64(parts[0]))) as Map).cast<String, dynamic>();
      claims = (jsonDecode(utf8.decode(_b64(parts[1]))) as Map).cast<String, dynamic>();
    } catch (_) {
      throw bad;
    }
    if (header['alg'] != 'RS256') throw bad;
    final jwks = _decode((await _http.get(Uri.parse(_jwks)).timeout(const Duration(seconds: 15))).body);
    final keys = [for (final k in (jwks?['keys'] as List? ?? const [])) (k as Map).cast<String, dynamic>()];
    final key = keys.where((k) => k['kty'] == 'RSA' && (header['kid'] == null || k['kid'] == header['kid'])).firstOrNull;
    if (key == null) throw bad;
    var valid = false;
    try {
      final signer = pc.RSASigner(pc.SHA256Digest(), '0609608648016503040201')
        ..init(false, pc.PublicKeyParameter<pc.RSAPublicKey>(pc.RSAPublicKey(_big(_b64(key['n'] as String)), _big(_b64(key['e'] as String)))));
      valid = signer.verifySignature(Uint8List.fromList(ascii.encode('${parts[0]}.${parts[1]}')), pc.RSASignature(_b64(parts[2])));
    } catch (_) {}
    final aud = claims['aud'];
    final now = nowSec();
    if (!valid ||
        claims['iss'] != _issuer ||
        !(aud == clientId || (aud is List && aud.contains(clientId))) ||
        (claims['exp'] as num? ?? 0) < now - 120 ||
        claims['nonce'] != nonce ||
        claims['sub'] is! String) {
      throw bad;
    }
    return claims;
  }
}
