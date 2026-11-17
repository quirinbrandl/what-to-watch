import 'package:material_ui/material_ui.dart';

import '../app/discover.dart';
import '../app/state.dart';
import '../core/models.dart';
import 'feed.dart';
import 'library.dart';
import 'settings.dart';
import 'widgets.dart';

/// Three places, one thumb: Discover · Library · Settings.
class Shell extends StatefulWidget {
  final bool autoRun;
  const Shell({super.key, this.autoRun = false});
  @override
  State<Shell> createState() => _ShellState();
}

class _ShellState extends State<Shell> {
  int tab = 0;

  @override
  void initState() {
    super.initState();
    discover.restore();
    if (widget.autoRun) WidgetsBinding.instance.addPostFrameCallback((_) => openFeed(context, start: true));
  }

  @override
  Widget build(BuildContext context) {
    final keyboard = MediaQuery.viewInsetsOf(context).bottom > 0;
    return Scaffold(
      resizeToAvoidBottomInset: false,
      body: Stack(children: [
        IndexedStack(index: tab, children: const [DiscoverScreen(), LibraryScreen(), SettingsScreen()]),
        if (!keyboard)
          Positioned(
            left: 0,
            right: 0,
            bottom: MediaQuery.paddingOf(context).bottom + 12,
            child: Center(
              child: Glass(
                radius: 999,
                padding: const EdgeInsets.all(6),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  _tab(0, Icons.auto_awesome_rounded, 'Discover'),
                  _tab(1, Icons.grid_view_rounded, 'Library'),
                  _tab(2, Icons.tune_rounded, 'Settings'),
                ]),
              ),
            ),
          ),
      ]),
    );
  }

  Widget _tab(int i, IconData icon, String label) {
    final on = tab == i;
    return Semantics(
      button: true,
      selected: on,
      label: label,
      child: InkWell(
        customBorder: const StadiumBorder(),
        onTap: () {
          tick();
          setState(() => tab = i);
        },
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOutCubic,
          height: 48,
          padding: EdgeInsets.symmetric(horizontal: on ? 18 : 16),
          decoration: BoxDecoration(color: on ? kInk : Colors.transparent, borderRadius: BorderRadius.circular(999)),
          child: ExcludeSemantics(
            child: Row(children: [
              Icon(icon, size: 21, color: on ? kBg : kDim),
              if (on) ...[const SizedBox(width: 8), Text(label, style: sans(13.5, w: 700, color: kBg))],
            ]),
          ),
        ),
      ),
    );
  }
}

void openFeed(BuildContext context, {bool start = false, Film? seed}) {
  if (start || seed != null) discover.start(seed: seed);
  Navigator.of(context).push(PageRouteBuilder(
    pageBuilder: (_, _, _) => const FeedScreen(),
    transitionDuration: const Duration(milliseconds: 380),
    reverseTransitionDuration: const Duration(milliseconds: 280),
    transitionsBuilder: (_, a, _, child) => FadeTransition(
      opacity: CurvedAnimation(parent: a, curve: Curves.easeOut),
      child: ScaleTransition(scale: Tween(begin: 1.04, end: 1.0).animate(CurvedAnimation(parent: a, curve: Curves.easeOutCubic)), child: child),
    ),
  ));
}

// ---------------------------------------------------------------- discover

class DiscoverScreen extends StatefulWidget {
  const DiscoverScreen({super.key});
  @override
  State<DiscoverScreen> createState() => _DiscoverScreenState();
}

class _DiscoverScreenState extends State<DiscoverScreen> {
  late final _text = TextEditingController(text: app.settings.request.prompt);
  final _focus = FocusNode();
  List<String> _wall = [];
  int _wallRev = -1;

  @override
  void initState() {
    super.initState();
    _buildWall();
  }

  @override
  void dispose() {
    _text.dispose();
    _focus.dispose();
    super.dispose();
  }

  /// The backdrop is the user's own films; trending fills in for new users.
  Future<void> _buildWall() async {
    _wallRev = app.lib.entries.length;
    final own = [
      for (final e in app.lib.entries.values)
        if (!e.notInterested && (e.watchlist || (e.rating ?? 0) >= 3.5) && app.film(e.id)?.poster != null) app.film(e.id)!.poster!
    ]..shuffle();
    var wall = own.take(48).toList();
    if (wall.length < 16) {
      try {
        wall = [...wall, for (final f in await app.tmdb.trending()) if (f.poster != null) f.poster!];
      } catch (_) {}
    }
    if (mounted) setState(() => _wall = wall);
  }

  void _go() {
    _focus.unfocus();
    app.settings.request.prompt = _text.text.trim();
    app.changed();
    if (!app.hasLlm) {
      toast(context, 'Sign in first — Settings → Account');
      return;
    }
    openFeed(context, start: true);
  }

  @override
  Widget build(BuildContext context) {
    final pad = MediaQuery.paddingOf(context);
    final keyboard = MediaQuery.viewInsetsOf(context).bottom;
    return ListenableBuilder(
      listenable: Listenable.merge([app, discover]),
      builder: (context, _) {
        if (_wallRev != app.lib.entries.length) _buildWall();
        final r = app.settings.request;
        final s = discover.session;
        return Stack(fit: StackFit.expand, children: [
          PosterWall(_wall),
          Padding(
            padding: EdgeInsets.fromLTRB(16, pad.top + 8, 16, keyboard > 0 ? keyboard + 12 : pad.bottom + 84),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Row(children: [
                Text('What to Watch', style: serif(24, italic: true)),
                const Spacer(),
                if (app.syncing)
                  const Padding(
                    padding: EdgeInsets.only(right: 4),
                    child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: kDim)),
                  ),
              ]),
              const Spacer(),
              if (s != null && keyboard == 0) ...[_lastPicks(s.picks.map((p) => p.film).toList()), const SizedBox(height: 14)],
              Glass(
                padding: const EdgeInsets.fromLTRB(6, 6, 6, 6),
                child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  TextField(
                    controller: _text,
                    focusNode: _focus,
                    minLines: 1,
                    maxLines: 3,
                    maxLength: 300,
                    textCapitalization: TextCapitalization.sentences,
                    textInputAction: TextInputAction.search,
                    onSubmitted: (_) => _go(),
                    style: sans(17, height: 1.3),
                    cursorColor: kAccent,
                    decoration: InputDecoration(
                      hintText: 'In the mood for…',
                      hintStyle: sans(17, color: kFaint),
                      counterText: '',
                      border: InputBorder.none,
                      contentPadding: const EdgeInsets.fromLTRB(16, 14, 8, 10),
                      suffixIcon: _text.text.isEmpty
                          ? null
                          : IconButton(
                              tooltip: 'Clear',
                              icon: const Icon(Icons.close_rounded, color: kDim, size: 20),
                              onPressed: () => setState(() {
                                _text.clear();
                                app.settings.request.prompt = '';
                              }),
                            ),
                    ),
                    onChanged: (_) => setState(() {}),
                  ),
                  SizedBox(
                    height: 44,
                    child: ListView(
                      scrollDirection: Axis.horizontal,
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                      children: [
                        for (final c in _pills(r)) Padding(padding: const EdgeInsets.only(right: 8), child: c),
                      ],
                    ),
                  ),
                  const SizedBox(height: 10),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(4, 0, 4, 4),
                    child: BigButton('Find films', icon: Icons.auto_awesome_rounded, onTap: _go, color: kAccent, ink: const Color(0xFF1B1300)),
                  ),
                ]),
              ),
            ]),
          ),
        ]);
      },
    );
  }

  Widget _lastPicks(List<Film> films) => Semantics(
        button: true,
        label: 'Open your last picks',
        child: GestureDetector(
          onTap: () {
            tick();
            openFeed(context);
          },
          child: SizedBox(
            height: 96,
            child: Row(children: [
              Expanded(
                child: ListView.separated(
                  scrollDirection: Axis.horizontal,
                  physics: const NeverScrollableScrollPhysics(),
                  itemCount: films.length.clamp(0, 6),
                  separatorBuilder: (_, _) => const SizedBox(width: 8),
                  itemBuilder: (_, i) => AspectRatio(aspectRatio: 2 / 3, child: Poster(films[i].poster, radius: 8, size: 'w185')),
                ),
              ),
              const SizedBox(width: 10),
              Container(
                width: 48,
                height: 48,
                decoration: const BoxDecoration(color: Color(0x22FFFFFF), shape: BoxShape.circle),
                child: const Icon(Icons.arrow_forward_rounded, color: kInk),
              ),
            ]),
          ),
        ),
      );

  List<Widget> _pills(dynamic r) {
    void sheet() => showModalBottomSheet(context: context, isScrollControlled: true, builder: (_) => const FilterSheet());
    final n = app.settings.request.hardFilters;
    final o = app.settings.request.obscurity;
    final years = r.yearMin != null || r.yearMax != null;
    final run = r.runMin != null || r.runMax != null;
    return [
      Chip2(n == 0 ? 'Filters' : 'Filters · $n', icon: Icons.tune_rounded, active: n > 0, onTap: sheet),
      Chip2(
        'My services',
        icon: Icons.live_tv_rounded,
        active: r.streamingOnly,
        onTap: () {
          if (app.settings.providers.isEmpty) {
            toast(context, 'Pick your services in Settings first');
            return;
          }
          r.streamingOnly = !r.streamingOnly;
          app.changed();
        },
      ),
      if (r.genres.isNotEmpty || r.notGenres.isNotEmpty)
        Chip2([...r.genres.map((g) => kGenres[g]), ...r.notGenres.map((g) => 'no ${kGenres[g]}')].join(', '), onTap: sheet),
      if (years) Chip2('${r.yearMin ?? '…'}–${r.yearMax ?? 'now'}', onTap: sheet),
      if (run) Chip2(r.runMax != null && r.runMin == null ? '≤ ${runtimeLabel(r.runMax)}' : '${r.runMin ?? 0}–${r.runMax ?? '∞'} min', onTap: sheet),
      if (r.langs.isNotEmpty) Chip2(r.langs.map((l) => kLanguages[l] ?? l).join(', '), onTap: sheet),
      if ((o - 0.5).abs() > 0.15) Chip2(o < 0.5 ? 'Familiar' : 'Obscure', onTap: sheet),
      if (!r.personalize) Chip2('Not personal', onTap: sheet),
    ];
  }
}

// ---------------------------------------------------------------- filters

class FilterSheet extends StatefulWidget {
  const FilterSheet({super.key});
  @override
  State<FilterSheet> createState() => _FilterSheetState();
}

class _FilterSheetState extends State<FilterSheet> {
  static const _y0 = 1920.0;
  static const _r0 = 60.0, _r1 = 240.0;
  bool _allLangs = false;

  void _set(VoidCallback f) {
    setState(f);
    app.changed();
  }

  Widget _head(String t, [String? value]) => Padding(
        padding: const EdgeInsets.fromLTRB(4, 22, 4, 10),
        child: Row(children: [
          Text(t, style: sans(12, w: 700, color: kDim, spacing: 1.2)),
          const Spacer(),
          if (value != null) Text(value, style: sans(13, w: 600)),
        ]),
      );

  @override
  Widget build(BuildContext context) {
    final r = app.settings.request;
    final y1 = DateTime.now().year.toDouble();
    final langs = _allLangs || r.langs.any((l) => !kLanguages.keys.take(8).contains(l)) ? kLanguages.keys : kLanguages.keys.take(8);
    return DraggableScrollableSheet(
      initialChildSize: 0.86,
      maxChildSize: 0.94,
      minChildSize: 0.5,
      expand: false,
      builder: (context, scroll) => Glass(
        radius: 32,
        color: const Color(0xE6131316),
        child: Column(children: [
          const SizedBox(height: 10),
          Container(width: 40, height: 4, decoration: BoxDecoration(color: kFaint, borderRadius: BorderRadius.circular(2))),
          Expanded(
            child: ListView(
              controller: scroll,
              padding: EdgeInsets.fromLTRB(18, 0, 18, MediaQuery.paddingOf(context).bottom + 24),
              children: [
                _head('GENRES', 'tap twice to exclude'),
                Wrap(spacing: 8, runSpacing: 8, children: [
                  for (final g in kGenres.entries)
                    Chip2(
                      g.value,
                      active: r.genres.contains(g.key),
                      negative: r.notGenres.contains(g.key),
                      onTap: () => _set(() {
                        if (r.genres.remove(g.key)) {
                          r.notGenres.add(g.key);
                        } else if (!r.notGenres.remove(g.key)) {
                          r.genres.add(g.key);
                        }
                      }),
                    ),
                ]),
                _head('YEAR', r.yearMin == null && r.yearMax == null ? 'Any' : '${r.yearMin ?? _y0.toInt()} – ${r.yearMax ?? 'now'}'),
                RangeSlider(
                  min: _y0,
                  max: y1,
                  divisions: (y1 - _y0).toInt(),
                  values: RangeValues((r.yearMin ?? _y0).toDouble().clamp(_y0, y1), (r.yearMax ?? y1).toDouble().clamp(_y0, y1)),
                  semanticFormatterCallback: (v) => '${v.round()}',
                  onChanged: (v) => _set(() {
                    r.yearMin = v.start <= _y0 ? null : v.start.round();
                    r.yearMax = v.end >= y1 ? null : v.end.round();
                  }),
                ),
                _head(
                    'LENGTH',
                    r.runMin == null && r.runMax == null
                        ? 'Any'
                        : '${r.runMin == null ? '' : '${runtimeLabel(r.runMin)} '}–${r.runMax == null ? '' : ' ${runtimeLabel(r.runMax)}'}'),
                RangeSlider(
                  min: _r0,
                  max: _r1,
                  divisions: ((_r1 - _r0) / 5).round(),
                  values: RangeValues((r.runMin ?? _r0).toDouble().clamp(_r0, _r1), (r.runMax ?? _r1).toDouble().clamp(_r0, _r1)),
                  semanticFormatterCallback: (v) => '${v.round()} minutes',
                  onChanged: (v) => _set(() {
                    r.runMin = v.start <= _r0 ? null : v.start.round();
                    r.runMax = v.end >= _r1 ? null : v.end.round();
                  }),
                ),
                _head('ORIGINAL LANGUAGE'),
                Wrap(spacing: 8, runSpacing: 8, children: [
                  for (final l in langs)
                    Chip2(kLanguages[l]!,
                        active: r.langs.contains(l), onTap: () => _set(() => r.langs.remove(l) ? null : r.langs.add(l))),
                  if (!_allLangs && langs.length < kLanguages.length) Chip2('More', icon: Icons.add_rounded, onTap: () => setState(() => _allLangs = true)),
                ]),
                _head('FAMILIAR ↔ OBSCURE', r.obscurity < 0.35 ? 'Familiar' : (r.obscurity > 0.65 ? 'Obscure' : 'Balanced')),
                Row(children: [
                  const Icon(Icons.local_fire_department_rounded, color: kDim, size: 20),
                  Expanded(
                    child: Slider(
                      value: r.obscurity,
                      divisions: 4,
                      semanticFormatterCallback: (v) => v < 0.35 ? 'Familiar' : (v > 0.65 ? 'Obscure' : 'Balanced'),
                      onChanged: (v) => _set(() => r.obscurity = v),
                    ),
                  ),
                  const Icon(Icons.diamond_outlined, color: kDim, size: 20),
                ]),
                const SizedBox(height: 14),
                _toggle(Icons.live_tv_rounded, 'Only on my services', r.streamingOnly, app.settings.providers.isEmpty ? null : (v) => _set(() => r.streamingOnly = v),
                    sub: app.settings.providers.isEmpty ? 'Pick services in Settings' : app.settings.providers.values.take(4).join(' · ')),
                _toggle(Icons.fingerprint_rounded, 'Personalize with my taste', r.personalize, (v) => _set(() => r.personalize = v)),
                _toggle(Icons.visibility_off_outlined, 'Hide films I have seen', r.excludeWatched, (v) => _set(() => r.excludeWatched = v)),
                const SizedBox(height: 18),
                Row(children: [
                  Expanded(
                    child: BigButton('Reset', color: const Color(0x1FFFFFFF), ink: kInk, onTap: () {
                      final prompt = r.prompt;
                      _set(() => app.settings.request = app.settings.request.copy()
                        ..genres.clear()
                        ..notGenres.clear()
                        ..langs.clear()
                        ..yearMin = null
                        ..yearMax = null
                        ..runMin = null
                        ..runMax = null
                        ..obscurity = 0.5
                        ..streamingOnly = false
                        ..personalize = true
                        ..excludeWatched = true
                        ..prompt = prompt);
                    }),
                  ),
                  const SizedBox(width: 12),
                  Expanded(child: BigButton('Done', onTap: () => Navigator.pop(context))),
                ]),
              ],
            ),
          ),
        ]),
      ),
    );
  }

  Widget _toggle(IconData icon, String label, bool value, ValueChanged<bool>? onChanged, {String? sub}) => MergeSemantics(
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: onChanged == null ? null : () => onChanged(!value),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
            child: Row(children: [
              Icon(icon, color: onChanged == null ? kFaint : kDim, size: 22),
              const SizedBox(width: 14),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(label, style: sans(15, w: 600, color: onChanged == null ? kFaint : kInk)),
                  if (sub != null) Text(sub, maxLines: 1, overflow: TextOverflow.ellipsis, style: sans(12, color: kDim)),
                ]),
              ),
              Switch(value: value, onChanged: onChanged, activeThumbColor: kBg, activeTrackColor: kAccent),
            ]),
          ),
        ),
      );
}
