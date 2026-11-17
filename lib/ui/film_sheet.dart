import 'package:material_ui/material_ui.dart';

import '../app/state.dart';
import '../core/models.dart';
import 'home.dart';
import 'widgets.dart';

Future<void> showFilmSheet(BuildContext context, Film film, {bool allowMoreLike = true}) =>
    showModalBottomSheet(context: context, isScrollControlled: true, builder: (_) => FilmSheet(film, allowMoreLike: allowMoreLike));

/// Where a film can be streamed in the user's region; their own services first.
class ProviderRow extends StatelessWidget {
  final Film film;
  const ProviderRow(this.film, {super.key});
  @override
  Widget build(BuildContext context) {
    final sv = app.services;
    final p = film.prov;
    if (p == null || p.region != sv.region) return const SizedBox();
    final list = p.streamable.toList()..sort((a, b) => (sv.has(b) ? 1 : 0) - (sv.has(a) ? 1 : 0));
    if (list.isEmpty) {
      final paid = {for (final x in [...p.rent, ...p.buy]) x.id: x}.values.toList();
      return Row(children: [
        const Icon(Icons.live_tv_rounded, size: 16, color: kFaint),
        const SizedBox(width: 8),
        Text(paid.isEmpty ? 'Not streaming in ${sv.region}' : 'Rent or buy', style: sans(12.5, color: kDim)),
        const SizedBox(width: 8),
        for (final x in paid.take(4)) Padding(padding: const EdgeInsets.only(right: 6), child: Opacity(opacity: 0.7, child: ProviderLogo(x.logo, x.name, size: 24))),
      ]);
    }
    return Wrap(spacing: 8, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
      for (final x in list.take(6))
        Container(
          padding: const EdgeInsets.all(2),
          decoration: BoxDecoration(borderRadius: BorderRadius.circular(11), border: Border.all(color: sv.has(x) ? kAccent : Colors.transparent, width: 1.5)),
          child: ProviderLogo(x.logo, x.name, size: 32),
        ),
    ]);
  }
}

String metaLine(Film f) => [if (f.year != null) '${f.year}', runtimeLabel(f.runtime), f.genreNames.take(3).join(', ')].where((s) => s.isNotEmpty).join('  ·  ');

/// Everything you can do with one film: rate, watchlist, seen, dismiss.
class FilmSheet extends StatefulWidget {
  final Film film;
  final bool allowMoreLike;
  const FilmSheet(this.film, {super.key, this.allowMoreLike = true});
  @override
  State<FilmSheet> createState() => _FilmSheetState();
}

class _FilmSheetState extends State<FilmSheet> {
  late Film f = widget.film;

  @override
  void initState() {
    super.initState();
    app.ensureFilm(f.id).then((x) {
      if (x != null && mounted) setState(() => f = x);
    });
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: app,
        builder: (context, _) {
          final e = app.lib[f.id];
          return DraggableScrollableSheet(
            initialChildSize: 0.8,
            maxChildSize: 0.94,
            minChildSize: 0.5,
            expand: false,
            builder: (context, scroll) => PosterTint(
              path: f.poster,
              builder: (context, tint) => Glass(
                radius: 32,
                color: Color.alphaBlend(tint.withValues(alpha: 0.10), const Color(0xEB121215)),
                child: ListView(
                  controller: scroll,
                  padding: EdgeInsets.fromLTRB(22, 10, 22, MediaQuery.paddingOf(context).bottom + 24),
                  children: [
                    Center(child: Container(width: 40, height: 4, decoration: BoxDecoration(color: kFaint, borderRadius: BorderRadius.circular(2)))),
                    const SizedBox(height: 20),
                    Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      SizedBox(width: 112, child: AspectRatio(aspectRatio: 2 / 3, child: Poster(f.poster, label: f.title, radius: 14))),
                      const SizedBox(width: 18),
                      Expanded(
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text(f.title, style: serif(30), maxLines: 3, overflow: TextOverflow.ellipsis),
                          const SizedBox(height: 8),
                          Text(metaLine(f), style: sans(13, color: kDim, height: 1.4)),
                          if (f.directors.isNotEmpty) ...[
                            const SizedBox(height: 4),
                            Text(f.directors.take(2).join(', '), style: sans(13, w: 600)),
                          ],
                          const SizedBox(height: 14),
                          Row(children: [
                            ScoreRing(f, size: 42),
                            const SizedBox(width: 10),
                            Text('TMDB\nuser score', style: sans(11, color: kDim, height: 1.25)),
                          ]),
                        ]),
                      ),
                    ]),
                    const SizedBox(height: 26),
                    Center(child: StarInput(value: e?.rating, onChanged: (v) => app.rate(f.id, v), size: 50)),
                    const SizedBox(height: 18),
                    Wrap(alignment: WrapAlignment.center, spacing: 8, runSpacing: 8, children: [
                      Chip2('Watchlist',
                          icon: e?.watchlist == true ? Icons.bookmark_rounded : Icons.bookmark_outline_rounded,
                          active: e?.watchlist == true,
                          onTap: e?.watched == true ? null : () => app.setWatchlist(f.id, !(e?.watchlist ?? false))),
                      Chip2('Seen',
                          icon: e?.watched == true ? Icons.visibility_rounded : Icons.visibility_outlined,
                          active: e?.watched == true,
                          onTap: () => app.setWatched(f.id, !(e?.watched ?? false))),
                      Chip2('Not for me', icon: Icons.block_rounded, negative: e?.notInterested == true, onTap: () => app.setNotInterested(f.id, !(e?.notInterested ?? false))),
                    ]),
                    const SizedBox(height: 24),
                    ProviderRow(f),
                    if (f.overview.isNotEmpty) ...[
                      const SizedBox(height: 20),
                      Text(f.overview, style: sans(14.5, color: kDim, height: 1.5)),
                    ],
                    if (widget.allowMoreLike) ...[
                      const SizedBox(height: 26),
                      BigButton('More like this', icon: Icons.auto_awesome_rounded, color: const Color(0x1FFFFFFF), ink: kInk, onTap: () {
                        if (!app.hasLlm) {
                          toast(context, 'Sign in first — Settings → Account');
                          return;
                        }
                        final nav = Navigator.of(context)..pop();
                        openFeed(nav.context, seed: f);
                      }),
                    ],
                  ],
                ),
              ),
            ),
          );
        },
      );
}
