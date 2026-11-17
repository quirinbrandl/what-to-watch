import 'package:file_picker/file_picker.dart';
import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';
import 'package:url_launcher/url_launcher.dart';

import '../app/discover.dart';
import '../app/state.dart';
import '../core/letterboxd.dart';
import '../core/models.dart';
import 'widgets.dart';

const kVersion = '1.0.0';

/// Picks a Letterboxd export ZIP and imports it, with a progress overlay.
Future<bool> pickAndImportZip(BuildContext context) async {
  final List<PlatformFile> picked;
  try {
    picked = await FilePicker.pickFiles(type: FileType.custom, allowedExtensions: ['zip']);
  } catch (_) {
    if (context.mounted) toast(context, 'Could not open the file picker');
    return false;
  }
  if (picked.isEmpty || !context.mounted) return false;
  showGeneralDialog(context: context, barrierDismissible: false, barrierColor: const Color(0xF2000000), pageBuilder: (_, _, _) => const ImportOverlay());
  var ok = false;
  String? error;
  try {
    await app.importZip(await picked.first.readAsBytes());
    ok = true;
  } on LbFormatException catch (e) {
    error = e.message;
  } catch (_) {
    error = 'The import did not finish. Check your connection and try again.';
  }
  if (context.mounted) {
    Navigator.of(context, rootNavigator: true).pop();
    toast(context, error ?? '${app.lib.rated.length} ratings · ${app.lib.watchlist.length} on your watchlist');
  }
  return ok;
}

class ImportOverlay extends StatelessWidget {
  const ImportOverlay({super.key});
  @override
  Widget build(BuildContext context) => PopScope(
        canPop: false,
        child: Material(
          type: MaterialType.transparency,
          child: ListenableBuilder(
            listenable: app,
            builder: (context, _) {
              final p = app.importing;
              final posters = [for (final f in p?.posters ?? const <Film>[]) f.poster!];
              return Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                if (posters.length >= 4) ...[
                  PosterRibbon([for (var i = 0; i < posters.length; i += 2) posters[i]], height: 150, speed: 34),
                  const SizedBox(height: 10),
                  PosterRibbon([for (var i = 1; i < posters.length; i += 2) posters[i]], height: 150, speed: 26, reverse: true),
                ] else
                  const SizedBox(height: 310),
                const SizedBox(height: 40),
                Text(p?.label ?? 'Opening', style: serif(32)),
                const SizedBox(height: 16),
                SizedBox(
                  width: 220,
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(4),
                    child: LinearProgressIndicator(
                      value: p == null || p.total == 0 ? null : p.done / p.total,
                      minHeight: 4,
                      color: kAccent,
                      backgroundColor: const Color(0x22FFFFFF),
                    ),
                  ),
                ),
                const SizedBox(height: 10),
                Text(p == null ? '' : '${p.done} / ${p.total}', style: sans(13, color: kDim)),
              ]);
            },
          ),
        ),
      );
}

Future<String?> askText(BuildContext context, String title, {String hint = '', String initial = '', bool secret = false, String action = 'Save'}) {
  final c = TextEditingController(text: initial);
  return showDialog<String>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: TextField(
        controller: c,
        autofocus: true,
        obscureText: secret,
        autocorrect: false,
        enableSuggestions: false,
        style: sans(16),
        cursorColor: kAccent,
        decoration: InputDecoration(hintText: hint, hintStyle: sans(16, color: kFaint)),
        onSubmitted: (v) => Navigator.pop(context, v),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: Text('Cancel', style: sans(14, color: kDim, w: 600))),
        TextButton(onPressed: () => Navigator.pop(context, c.text), child: Text(action, style: sans(14, color: kAccent, w: 700))),
      ],
    ),
  );
}

Future<bool> confirm(BuildContext context, String title, String body, String action, {bool danger = false}) async =>
    await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: Text(body),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: Text('Cancel', style: sans(14, color: kDim, w: 600))),
          TextButton(onPressed: () => Navigator.pop(context, true), child: Text(action, style: sans(14, color: danger ? kDanger : kAccent, w: 700))),
        ],
      ),
    ) ==
    true;

/// Shown once, the first time ChatGPT plan usage is enabled.
Future<void> showPlanWelcome(BuildContext context) async {
  if (app.settings.welcomeSeen || app.settings.useApiKey) return;
  app.settings.welcomeSeen = true;
  app.changed();
  await showDialog<void>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text('You\'re using your ChatGPT plan'),
      content: const Text('Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT settings.'),
      actions: [TextButton(onPressed: () => Navigator.pop(context), child: Text('Got it', style: sans(14, color: kAccent, w: 700)))],
    ),
  );
}

Future<void> signInFlow(BuildContext context) async {
  try {
    await app.signIn();
    if (context.mounted) await showPlanWelcome(context);
  } catch (e) {
    if (context.mounted) toast(context, '$e');
  }
}

Future<void> apiKeyFlow(BuildContext context) async {
  final key = await askText(context, 'OpenAI API key', hint: 'sk-…', secret: true, action: 'Use key');
  if (key == null || key.trim().isEmpty || !context.mounted) return;
  try {
    await app.setApiKey(key.trim());
    if (context.mounted) toast(context, 'API key saved on this device');
  } catch (_) {
    if (context.mounted) toast(context, 'That key was not accepted');
  }
}

void pickRegion(BuildContext context) {
  final entries = kRegions.entries.toList()..sort((a, b) => a.value.compareTo(b.value));
  showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    builder: (context) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.7,
      maxChildSize: 0.92,
      builder: (context, scroll) => Glass(
        radius: 32,
        color: const Color(0xEB131316),
        child: ListView(controller: scroll, padding: const EdgeInsets.symmetric(vertical: 16), children: [
          for (final e in entries)
            ListTile(
              title: Text(e.value, style: sans(16, w: e.key == app.settings.region ? 800 : 500)),
              trailing: e.key == app.settings.region ? const Icon(Icons.check_rounded, color: kAccent) : null,
              onTap: () {
                app.setRegion(e.key);
                Navigator.pop(context);
              },
            ),
        ]),
      ),
    ),
  );
}

/// Logos of the region's streaming services; tap to mark the ones you have.
class ServicesGrid extends StatefulWidget {
  const ServicesGrid({super.key});
  @override
  State<ServicesGrid> createState() => _ServicesGridState();
}

class _ServicesGridState extends State<ServicesGrid> {
  String? _region;
  Future<List<Prov>>? _catalog;

  @override
  Widget build(BuildContext context) {
    if (_region != app.settings.region) {
      _region = app.settings.region;
      _catalog = app.providerCatalog();
    }
    return FutureBuilder(
      future: _catalog,
      builder: (context, snap) {
        if (snap.hasError) {
          return Padding(
            padding: const EdgeInsets.all(12),
            child: Chip2('Could not load services — retry', icon: Icons.refresh_rounded, onTap: () => setState(() => _region = null)),
          );
        }
        final all = snap.data;
        if (all == null) return const SizedBox(height: 120, child: Center(child: CircularProgressIndicator(strokeWidth: 2, color: kDim)));
        final mine = app.settings.providers;
        final list = [...all.where((p) => mine.containsKey(p.id)), ...all.where((p) => !mine.containsKey(p.id)).take(28 - mine.length.clamp(0, 28))];
        return Wrap(spacing: 10, runSpacing: 10, children: [
          for (final p in list)
            Semantics(
              button: true,
              selected: mine.containsKey(p.id),
              label: p.name,
              child: GestureDetector(
                onTap: () {
                  tick();
                  app.toggleProvider(p);
                },
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 160),
                  padding: const EdgeInsets.all(3),
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(17),
                    border: Border.all(color: mine.containsKey(p.id) ? kAccent : Colors.transparent, width: 2.4),
                  ),
                  child: Opacity(opacity: mine.containsKey(p.id) ? 1 : 0.55, child: ExcludeSemantics(child: ProviderLogo(p.logo, p.name, size: 52))),
                ),
              ),
            ),
        ]);
      },
    );
  }
}

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  String _ago(int? sec) {
    if (sec == null) return 'never';
    final d = nowSec() - sec;
    if (d < 90) return 'just now';
    if (d < 3600) return '${d ~/ 60} min ago';
    if (d < 86400) return '${d ~/ 3600} h ago';
    return '${d ~/ 86400} d ago';
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: app,
        builder: (context, _) {
          final pad = MediaQuery.paddingOf(context);
          final lib = app.lib;
          final s = app.settings;
          final modelName = s.model == null ? 'Automatic' : (app.models.where((m) => m.slug == s.model).firstOrNull?.name ?? s.model!);
          return ListView(
            padding: EdgeInsets.fromLTRB(16, pad.top + 8, 16, pad.bottom + 110),
            children: [
              Text('Settings', style: serif(40)),
              _Section('ACCOUNT', [
                if (s.useApiKey && app.apiKey != null)
                  const _Item(Icons.key_rounded, 'OpenAI API key', sub: 'Billed to your API account')
                else if (app.auth.signedIn) ...[
                  _Item(Icons.account_circle_outlined, app.auth.email ?? 'ChatGPT', sub: 'Using ChatGPT plan'),
                  _Item(Icons.data_usage_rounded, 'Manage usage',
                      trailing: Icons.open_in_new_rounded, onTap: () => launchUrl(Uri.parse('https://chatgpt.com/settings/usage'), mode: LaunchMode.externalApplication)),
                  _Item(Icons.logout_rounded, 'Sign out', onTap: () async {
                    if (!await confirm(context, 'Sign out?', 'Your library stays on this device.', 'Sign out')) return;
                    final ok = await app.signOut();
                    if (context.mounted && !ok) toast(context, 'Signed out here. To be sure, also disconnect the app in ChatGPT settings.');
                  }),
                ] else
                  Padding(
                    padding: const EdgeInsets.all(12),
                    child: BigButton('Continue with ChatGPT', onTap: () => signInFlow(context)),
                  ),
                if (app.hasLlm)
                  _Item(Icons.memory_rounded, 'Model', sub: modelName, onTap: () async {
                    if (app.models.isEmpty) await app.loadModels();
                    if (!context.mounted) return;
                    showModalBottomSheet(
                      context: context,
                      builder: (context) => Glass(
                        radius: 32,
                        color: const Color(0xEB131316),
                        child: ListView(shrinkWrap: true, padding: EdgeInsets.fromLTRB(0, 16, 0, MediaQuery.paddingOf(context).bottom + 16), children: [
                          for (final m in [null, ...app.models])
                            ListTile(
                              title: Text(m?.name ?? 'Automatic', style: sans(16, w: s.model == m?.slug ? 800 : 500)),
                              subtitle: m == null ? Text('Your account\'s default model', style: sans(12.5, color: kDim)) : null,
                              trailing: s.model == m?.slug ? const Icon(Icons.check_rounded, color: kAccent) : null,
                              onTap: () {
                                s.model = m?.slug;
                                app.changed();
                                Navigator.pop(context);
                              },
                            ),
                        ]),
                      ),
                    );
                  }),
              ]),
              _Section('LETTERBOXD', [
                _Item(Icons.alternate_email_rounded, lib.lbUsername ?? 'Add your username', sub: lib.lbUsername == null ? 'Keeps new diary entries in sync' : 'Username', onTap: () async {
                  final v = await askText(context, 'Letterboxd username', initial: lib.lbUsername ?? '', hint: 'username');
                  if (v == null) return;
                  if (v.trim().isEmpty) {
                    app.setUsername(null);
                  } else if (cleanUsername(v) == null) {
                    if (context.mounted) toast(context, 'That does not look like a username');
                  } else {
                    app.setUsername(v);
                  }
                }),
                if (lib.lbUsername != null)
                  _Item(Icons.sync_rounded, 'Sync now',
                      sub: app.syncing
                          ? 'Checking your diary…'
                          : (app.syncError ?? 'Synced ${_ago(lib.lbLastSync)}${app.lastSyncAdded > 0 ? ' · ${app.lastSyncAdded} new' : ''}'),
                      warn: app.syncError != null,
                      busy: app.syncing,
                      onTap: app.syncLetterboxd),
                _Item(Icons.folder_zip_outlined, 'Import export ZIP',
                    sub: lib.lbImportAt == null ? 'Letterboxd → Settings → Data → Export' : 'Ratings, watched, watchlist, likes, lists',
                    onTap: () => pickAndImportZip(context)),
                if (lib.lbGap)
                  const _Item(Icons.warning_amber_rounded, 'Some diary entries may be missing',
                      sub: 'More than 50 were logged since the last sync. Import a fresh ZIP to fill the gap.', warn: true),
                if (lib.unmatched.isNotEmpty)
                  _Item(Icons.help_outline_rounded, '${lib.unmatched.length} not matched', sub: 'Mostly series, which are not films on TMDB', onTap: () {
                    showDialog<void>(
                      context: context,
                      builder: (context) => AlertDialog(
                        title: const Text('Not matched'),
                        content: SingleChildScrollView(child: Text(lib.unmatched.join('\n'))),
                        actions: [TextButton(onPressed: () => Navigator.pop(context), child: Text('Close', style: sans(14, color: kAccent, w: 700)))],
                      ),
                    );
                  }),
              ]),
              _Section('WHERE YOU WATCH', [
                _Item(Icons.public_rounded, 'Region', sub: kRegions[s.region] ?? s.region, onTap: () => pickRegion(context)),
                const Padding(padding: EdgeInsets.fromLTRB(12, 6, 12, 14), child: ServicesGrid()),
              ]),
              _Section('ADVANCED', [
                _Item(Icons.key_rounded, 'OpenAI API key', sub: app.apiKey == null ? 'Use your own key instead of ChatGPT' : (s.useApiKey ? 'In use' : 'Saved'), onTap: () async {
                  if (app.apiKey == null) return apiKeyFlow(context);
                  if (await confirm(context, 'Remove API key?', 'The key is deleted from this device.', 'Remove', danger: true)) app.setApiKey(null);
                }),
              ]),
              _Section('YOUR DATA', [
                _Item(Icons.ios_share_rounded, 'Export backup', sub: 'Library and settings, no credentials', onTap: () async {
                  try {
                    final day = DateTime.now().toIso8601String().substring(0, 10);
                    final uri = await FilePicker.saveFile(fileName: 'what-to-watch-$day.json', bytes: app.backupBytes(), mimeType: 'application/json');
                    if (context.mounted && uri != null) toast(context, 'Backup saved');
                  } catch (_) {
                    if (context.mounted) toast(context, 'Backup could not be saved');
                  }
                }),
                _Item(Icons.settings_backup_restore_rounded, 'Restore backup', onTap: () async {
                  try {
                    final picked = await FilePicker.pickFiles(type: FileType.custom, allowedExtensions: ['json']);
                    if (picked.isEmpty || !context.mounted) return;
                    if (!await confirm(context, 'Restore backup?', 'This replaces the library on this device.', 'Restore')) return;
                    await app.restore(await picked.first.readAsBytes());
                    discover.clear();
                    if (context.mounted) toast(context, 'Backup restored');
                  } on FormatException catch (e) {
                    if (context.mounted) toast(context, e.message);
                  } catch (_) {
                    if (context.mounted) toast(context, 'Restore failed');
                  }
                }),
                _Item(Icons.delete_outline_rounded, 'Delete everything', danger: true, onTap: () async {
                  if (!await confirm(context, 'Delete everything?', 'Library, settings, sign-in and caches are erased from this device. This cannot be undone.', 'Delete', danger: true)) return;
                  discover.clear();
                  await app.deleteAll();
                }),
              ]),
              _Section('ABOUT', [
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(999),
                        gradient: const LinearGradient(colors: [Color(0xFF90CEA1), Color(0xFF3CBEC9), Color(0xFF01B4E4)]),
                      ),
                      child: Text('TMDB', style: sans(13, w: 800, color: const Color(0xFF0D253F), spacing: 1)),
                    ),
                    const SizedBox(height: 10),
                    Text('This product uses the TMDB API but is not endorsed or certified by TMDB. Film data and images come from TMDB.',
                        style: sans(12.5, color: kDim, height: 1.45)),
                    const SizedBox(height: 8),
                    Text('Streaming availability is provided by JustWatch.', style: sans(12.5, color: kDim, height: 1.45)),
                  ]),
                ),
                _Item(Icons.shield_outlined, 'Privacy', sub: 'Everything stays on this device', onTap: () async {
                  final text = await rootBundle.loadString('PRIVACY.md');
                  if (!context.mounted) return;
                  showDialog<void>(
                    context: context,
                    builder: (context) => AlertDialog(
                      title: const Text('Privacy'),
                      content: SingleChildScrollView(child: Text(text.replaceAll(RegExp(r'^#+ ', multiLine: true), '').replaceAll('**', ''))),
                      actions: [TextButton(onPressed: () => Navigator.pop(context), child: Text('Close', style: sans(14, color: kAccent, w: 700)))],
                    ),
                  );
                }),
                _Item(Icons.article_outlined, 'Open-source licenses', sub: 'What to Watch $kVersion · MIT', onTap: () => showLicensePage(context: context, applicationName: 'What to Watch', applicationVersion: kVersion)),
              ]),
            ],
          );
        },
      );
}

class _Section extends StatelessWidget {
  final String title;
  final List<Widget> children;
  const _Section(this.title, this.children);
  @override
  Widget build(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(6, 26, 6, 10),
          child: Semantics(header: true, child: Text(title, style: sans(12, w: 700, color: kDim, spacing: 1.2))),
        ),
        Container(
          decoration: BoxDecoration(color: kCard, borderRadius: BorderRadius.circular(22), border: Border.all(color: kLine)),
          clipBehavior: Clip.antiAlias,
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
        ),
      ]);
}

class _Item extends StatelessWidget {
  final IconData icon;
  final String title;
  final String? sub;
  final VoidCallback? onTap;
  final bool danger, warn, busy;
  final IconData? trailing;
  const _Item(this.icon, this.title, {this.sub, this.onTap, this.danger = false, this.warn = false, this.busy = false, this.trailing});
  @override
  Widget build(BuildContext context) {
    final c = danger ? kDanger : kInk;
    return MergeSemantics(
      child: InkWell(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 60),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            child: Row(children: [
              Icon(icon, size: 22, color: warn ? kAccent : (danger ? kDanger : kDim)),
              const SizedBox(width: 16),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(title, style: sans(15.5, w: 600, color: c)),
                  if (sub != null) ...[const SizedBox(height: 2), Text(sub!, style: sans(12.5, color: warn ? kAccent : kDim, height: 1.35))],
                ]),
              ),
              if (busy)
                const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: kDim))
              else if (onTap != null)
                Icon(trailing ?? Icons.chevron_right_rounded, size: 20, color: kFaint),
            ]),
          ),
        ),
      ),
    );
  }
}
