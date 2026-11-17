import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:material_ui/material_ui.dart';
import 'package:url_launcher/url_launcher.dart';

import '../app/discover.dart';
import '../app/state.dart';
import '../core/engine/recommender.dart';
import 'film_sheet.dart';
import 'widgets.dart';

/// Results: one poster per screen, swipe up for the next, tap to flip.
class FeedScreen extends StatefulWidget {
  const FeedScreen({super.key});
  @override
  State<FeedScreen> createState() => _FeedScreenState();
}

class _FeedScreenState extends State<FeedScreen> {
  final _pages = PageController();
  int _index = 0;

  @override
  void dispose() {
    _pages.dispose();
    super.dispose();
  }

  void _close() {
    if (discover.running && discover.session == null) discover.cancel();
    Navigator.of(context).maybePop();
  }

  @override
  Widget build(BuildContext context) => PopScope(
        onPopInvokedWithResult: (_, _) {
          if (discover.running && discover.session == null) discover.cancel();
        },
        child: Scaffold(
          body: ListenableBuilder(
            listenable: Listenable.merge([discover, app]),
            builder: (context, _) {
              final s = discover.session;
              final Widget body;
              String? backdrop;
              if (s == null) {
                body = discover.running ? const Scouting() : _problem();
              } else if (s.picks.isEmpty && !discover.running) {
                body = Blank(Icons.filter_alt_off_rounded, 'No film fits all of that', action: 'Change filters', onAction: _close);
              } else {
                final picks = s.picks;
                if (_index > picks.length) _index = picks.length;
                backdrop = _index < picks.length ? picks[_index].film.poster : (picks.isEmpty ? null : picks.last.film.poster);
                body = PageView.builder(
                  controller: _pages,
                  scrollDirection: Axis.vertical,
                  physics: const BouncingScrollPhysics(parent: PageScrollPhysics()),
                  itemCount: picks.length + 1,
                  onPageChanged: (i) {
                    tick();
                    setState(() => _index = i);
                  },
                  itemBuilder: (context, i) => i < picks.length
                      ? _PickPage(picks[i], key: ValueKey(picks[i].film.id), first: i == 0)
                      : _MorePage(s, onClose: _close),
                );
              }
              final pad = MediaQuery.paddingOf(context);
              return Stack(fit: StackFit.expand, children: [
                _Backdrop(backdrop),
                body,
                Positioned(
                  top: pad.top + 6,
                  left: 10,
                  right: 16,
                  child: Row(children: [
                    RoundButton(Icons.keyboard_arrow_down_rounded, 'Close', onTap: _close, size: 46),
                    const Spacer(),
                    if (s != null && s.picks.isNotEmpty && _index < s.picks.length)
                      ExcludeSemantics(child: Text('${_index + 1} / ${s.picks.length}', style: sans(13, w: 700, color: kDim))),
                  ]),
                ),
                if (s?.notice != null && s!.picks.isNotEmpty)
                  Positioned(
                    top: pad.top + 14,
                    left: 70,
                    right: 70,
                    child: Center(
                      child: Glass(
                        radius: 999,
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                        child: Text(s.notice!, style: sans(12, w: 600, color: kAccent), maxLines: 1, overflow: TextOverflow.ellipsis),
                      ),
                    ),
                  ),
              ]);
            },
          ),
        ),
      );

  Widget _problem() {
    final e = discover.llmError;
    if (discover.error == null) return Blank(Icons.movie_filter_outlined, 'Nothing here yet', action: 'Back', onAction: _close);
    if (e != null && e.needsSignIn) {
      return Blank(Icons.lock_outline_rounded, 'Please sign in again', action: 'Continue with ChatGPT', onAction: () async {
        try {
          await app.signIn();
          discover.start();
        } catch (x) {
          if (mounted) toast(context, '$x');
        }
      });
    }
    if (e != null && e.usageLimit) {
      return Blank(Icons.hourglass_bottom_rounded, 'ChatGPT usage limit reached',
          action: 'Manage usage', onAction: () => launchUrl(Uri.parse('https://chatgpt.com/settings/usage'), mode: LaunchMode.externalApplication));
    }
    return Blank(Icons.cloud_off_rounded, discover.error!, action: 'Try again', onAction: () => discover.start());
  }
}

/// The current poster, blown up and blurred, colours the whole screen.
class _Backdrop extends StatelessWidget {
  final String? path;
  const _Backdrop(this.path);
  @override
  Widget build(BuildContext context) => RepaintBoundary(
        child: AnimatedSwitcher(
          duration: const Duration(milliseconds: 600),
          child: path == null
              ? const ColoredBox(key: ValueKey('none'), color: kBg, child: SizedBox.expand())
              : Stack(key: ValueKey(path), fit: StackFit.expand, children: [
                  ImageFiltered(
                    imageFilter: ui.ImageFilter.blur(sigmaX: 48, sigmaY: 48, tileMode: TileMode.mirror),
                    child: Transform.scale(scale: 1.25, child: Poster(path, radius: 0, size: 'w185')),
                  ),
                  const DecoratedBox(
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        colors: [Color(0x99000000), Color(0x73000000), Color(0xD9000000)],
                      ),
                    ),
                  ),
                ]),
        ),
      );
}

class _PickPage extends StatefulWidget {
  final Pick pick;
  final bool first;
  const _PickPage(this.pick, {super.key, this.first = false});
  @override
  State<_PickPage> createState() => _PickPageState();
}

class _PickPageState extends State<_PickPage> with SingleTickerProviderStateMixin {
  late final _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 560));

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  void _flip() {
    thud();
    _c.status == AnimationStatus.completed || _c.status == AnimationStatus.forward ? _c.reverse() : _c.forward();
    if (!app.settings.flipHintSeen) {
      app.settings.flipHintSeen = true;
      app.changed();
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.pick;
    final f = p.film;
    final e = app.lib[f.id];
    final pad = MediaQuery.paddingOf(context);
    return Padding(
      padding: EdgeInsets.only(top: pad.top + 60, bottom: pad.bottom + 14),
      child: Column(children: [
        Expanded(
          child: LayoutBuilder(builder: (context, box) {
            final w = math.min(box.maxWidth - 36, (box.maxHeight - 8) / 1.5);
            return Center(
              child: PosterTint(
                path: f.poster,
                builder: (context, tint) => Semantics(
                  button: true,
                  label: '${f.label}. Tap to flip for details.',
                  child: GestureDetector(
                    onTap: _flip,
                    child: AnimatedBuilder(
                      animation: _c,
                      builder: (context, _) {
                        final t = Curves.easeInOutCubic.transform(_c.value);
                        final back = t > 0.5;
                        return Transform(
                          alignment: Alignment.center,
                          transform: Matrix4.identity()
                            ..setEntry(3, 2, 0.0011)
                            ..rotateY(t * math.pi)
                            ..scaleByDouble(1 - 0.07 * math.sin(t * math.pi), 1 - 0.07 * math.sin(t * math.pi), 1, 1),
                          child: Container(
                            width: w,
                            height: w * 1.5,
                            decoration: BoxDecoration(borderRadius: BorderRadius.circular(28), boxShadow: [
                              BoxShadow(color: tint.withValues(alpha: 0.38), blurRadius: 70, spreadRadius: -6, offset: const Offset(0, 26)),
                              const BoxShadow(color: Color(0x99000000), blurRadius: 30, offset: Offset(0, 14)),
                            ]),
                            child: back
                                ? Transform(alignment: Alignment.center, transform: Matrix4.rotationY(math.pi), child: _Back(p, tint))
                                : Stack(fit: StackFit.expand, children: [
                                    Poster(f.poster, label: f.title, radius: 28, size: 'w780'),
                                    if (widget.first && !app.settings.flipHintSeen)
                                      Align(
                                        alignment: const Alignment(0, 0.9),
                                        child: Glass(
                                          radius: 999,
                                          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
                                          child: Row(mainAxisSize: MainAxisSize.min, children: [
                                            const Icon(Icons.flip_rounded, size: 16, color: kInk),
                                            const SizedBox(width: 8),
                                            Text('Tap to flip', style: sans(12.5, w: 700)),
                                          ]),
                                        ),
                                      ),
                                  ]),
                          ),
                        );
                      },
                    ),
                  ),
                ),
              ),
            );
          }),
        ),
        const SizedBox(height: 14),
        Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
          RoundButton(Icons.close_rounded, 'Not for me', showLabel: true, onTap: () {
            app.setNotInterested(f.id, true);
            discover.remove(p);
          }),
          RoundButton(e?.watchlist == true ? Icons.bookmark_rounded : Icons.bookmark_outline_rounded, 'Watchlist',
              showLabel: true, active: e?.watchlist == true, onTap: e?.watched == true ? null : () => app.setWatchlist(f.id, !(e?.watchlist ?? false))),
          RoundButton(e?.rating != null ? Icons.star_rounded : Icons.star_outline_rounded, e?.rating != null ? '${e!.rating}★' : 'Seen it',
              showLabel: true, active: e?.watched == true, onTap: () => showFilmSheet(context, f, allowMoreLike: false)),
          RoundButton(Icons.auto_awesome_rounded, 'More like it', showLabel: true, onTap: () => discover.start(seed: f)),
        ]),
      ]),
    );
  }
}

/// Back of the card: the facts, and why this film fits this user.
class _Back extends StatelessWidget {
  final Pick p;
  final Color tint;
  const _Back(this.p, this.tint);

  @override
  Widget build(BuildContext context) {
    final f = p.film;
    Widget label(String t) => Padding(
          padding: const EdgeInsets.only(top: 20, bottom: 8),
          child: Text(t, style: sans(11, w: 800, color: Color.lerp(tint, kInk, 0.45)!, spacing: 1.4)),
        );
    return Container(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(28),
        border: Border.all(color: kLine),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [Color.alphaBlend(tint.withValues(alpha: 0.30), const Color(0xFF141417)), const Color(0xFF101013)],
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(22, 24, 22, 24),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(f.title, style: serif(34)),
          const SizedBox(height: 10),
          Text(metaLine(f), style: sans(13, color: kDim, height: 1.4)),
          if (f.directors.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text('Directed by ${f.directors.take(2).join(', ')}', style: sans(13, w: 600)),
          ],
          const SizedBox(height: 18),
          Row(children: [
            ScoreRing(f),
            const SizedBox(width: 10),
            Text('TMDB\nuser score', style: sans(11, color: kDim, height: 1.25)),
            const Spacer(),
            if (p.personal)
              Semantics(
                label: 'Predicted for you: ${p.predicted.toStringAsFixed(1)} stars',
                child: ExcludeSemantics(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
                    Row(mainAxisSize: MainAxisSize.min, children: [
                      const Icon(Icons.star_rounded, color: kAccent, size: 22),
                      const SizedBox(width: 3),
                      Text(p.predicted.toStringAsFixed(1), style: sans(22, w: 800)),
                    ]),
                    Text('predicted for you', style: sans(11, color: kDim)),
                  ]),
                ),
              ),
          ]),
          const SizedBox(height: 16),
          ProviderRow(f),
          label('WHY IT FITS'),
          Text(p.why, style: sans(16, height: 1.45)),
          if (p.anchors.isNotEmpty) ...[
            const SizedBox(height: 14),
            Wrap(spacing: 10, runSpacing: 10, children: [
              for (final a in p.anchors)
                Container(
                  padding: const EdgeInsets.fromLTRB(5, 5, 12, 5),
                  decoration: BoxDecoration(color: const Color(0x14FFFFFF), borderRadius: BorderRadius.circular(12)),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    SizedBox(width: 30, height: 45, child: Poster(a.poster, radius: 6, size: 'w92')),
                    const SizedBox(width: 10),
                    Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                      ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 150),
                        child: Text(a.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: sans(12.5, w: 700)),
                      ),
                      const SizedBox(height: 3),
                      if (app.lib[a.id]?.rating != null) Stars(app.lib[a.id]!.rating!, size: 13),
                    ]),
                  ]),
                ),
            ]),
          ],
          for (final fact in p.facts)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Padding(padding: EdgeInsets.only(top: 2), child: Icon(Icons.check_circle_outline_rounded, size: 16, color: kDim)),
                const SizedBox(width: 8),
                Expanded(child: Text(fact, style: sans(13.5, color: kDim, height: 1.35))),
              ]),
            ),
          if (f.overview.isNotEmpty) ...[
            label('STORY'),
            Text(f.overview, style: sans(14, color: kDim, height: 1.5)),
          ],
        ]),
      ),
    );
  }
}

class _MorePage extends StatelessWidget {
  final Session s;
  final VoidCallback onClose;
  const _MorePage(this.s, {required this.onClose});
  @override
  Widget build(BuildContext context) {
    if (discover.loadingMore) return const Scouting(compact: true);
    if (discover.error != null) {
      return Blank(Icons.cloud_off_rounded, discover.error!, action: 'Try again', onAction: discover.more);
    }
    if (s.exhausted && s.reserve.isEmpty) {
      return Blank(Icons.done_all_rounded, 'That was everything', action: 'New search', onAction: onClose);
    }
    return Center(
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        RoundButton(Icons.expand_more_rounded, 'More films', size: 92, onTap: discover.more),
        const SizedBox(height: 16),
        Text('More', style: serif(30)),
      ]),
    );
  }
}

/// The wait, made of the real candidates as they are found.
class Scouting extends StatelessWidget {
  final bool compact;
  const Scouting({super.key, this.compact = false});

  static const _steps = [
    (Stage.taste, Icons.fingerprint_rounded, 'Reading your taste'),
    (Stage.scouting, Icons.travel_explore_rounded, 'Scouting'),
    (Stage.checking, Icons.fact_check_outlined, 'Checking the facts'),
    (Stage.judging, Icons.auto_awesome_rounded, 'Choosing for you'),
  ];

  @override
  Widget build(BuildContext context) {
    var posters = [for (final f in discover.scouted) if (f.poster != null) f.poster!];
    if (posters.length < 9) {
      posters = [
        ...posters,
        for (final e in app.lib.entries.values.take(60))
          if (app.film(e.id)?.poster != null) app.film(e.id)!.poster!
      ];
    }
    final stage = discover.stage ?? Stage.taste;
    final step = _steps.firstWhere((s) => s.$1 == stage);
    final h = compact ? 118.0 : 158.0;
    List<String> row(int r) => [for (var i = r; i < posters.length; i += 3) posters[i]];
    return Semantics(
      liveRegion: true,
      label: step.$3,
      child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
        if (posters.isNotEmpty)
          ShaderMask(
            shaderCallback: (r) => const LinearGradient(colors: [Colors.transparent, Colors.white, Colors.white, Colors.transparent], stops: [0, 0.18, 0.82, 1])
                .createShader(r),
            blendMode: BlendMode.dstIn,
            child: Transform.rotate(
              angle: -0.05,
              child: Column(children: [
                PosterRibbon(row(0), height: h, speed: 30),
                const SizedBox(height: 10),
                PosterRibbon(row(1), height: h, speed: 22, reverse: true),
                if (!compact) ...[const SizedBox(height: 10), PosterRibbon(row(2), height: h, speed: 36)],
              ]),
            ),
          ),
        SizedBox(height: compact ? 26 : 40),
        ExcludeSemantics(
          child: Column(children: [
            Row(mainAxisSize: MainAxisSize.min, children: [
              for (final s in _steps) ...[
                AnimatedContainer(
                  duration: const Duration(milliseconds: 300),
                  width: 42,
                  height: 42,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: s.$1 == stage ? kAccent : (s.$1.index < stage.index ? const Color(0x33FFFFFF) : const Color(0x12FFFFFF)),
                  ),
                  child: Icon(s.$2, size: 20, color: s.$1 == stage ? const Color(0xFF1B1300) : (s.$1.index < stage.index ? kInk : kFaint)),
                ),
                if (s != _steps.last) Container(width: 22, height: 2, color: s.$1.index < stage.index ? const Color(0x55FFFFFF) : const Color(0x14FFFFFF)),
              ],
            ]),
            const SizedBox(height: 22),
            AnimatedSwitcher(
              duration: const Duration(milliseconds: 250),
              child: Text(step.$3, key: ValueKey(step.$3), style: serif(compact ? 26 : 32)),
            ),
            const SizedBox(height: 8),
            Text(
              stage == Stage.judging
                  ? '${discover.pool} finalists'
                  : (discover.pool > 0 ? '${discover.pool} films in play' : 'This takes about a minute'),
              style: sans(13, color: kDim),
            ),
          ]),
        ),
      ]),
    );
  }
}
