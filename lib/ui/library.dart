import 'dart:async';

import 'package:material_ui/material_ui.dart';

import '../app/state.dart';
import '../core/models.dart';
import 'film_sheet.dart';
import 'settings.dart' show pickAndImportZip;
import 'widgets.dart';

/// The user's films as a poster grid: rated, watchlist, watched.
class LibraryScreen extends StatefulWidget {
  const LibraryScreen({super.key});
  @override
  State<LibraryScreen> createState() => _LibraryScreenState();
}

class _LibraryScreenState extends State<LibraryScreen> {
  int tab = 0;
  bool byRating = false;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: app,
        builder: (context, _) {
          final lib = app.lib;
          final lists = [
            lib.rated.toList()
              ..sort((a, b) => byRating
                  ? (b.rating!.compareTo(a.rating!) != 0 ? b.rating!.compareTo(a.rating!) : (b.ratingAt ?? 0).compareTo(a.ratingAt ?? 0))
                  : (b.ratingAt ?? 0).compareTo(a.ratingAt ?? 0)),
            lib.watchlist.toList()..sort((a, b) => (b.watchlistAt ?? 0).compareTo(a.watchlistAt ?? 0)),
            lib.watched.toList()..sort((a, b) => (b.watchedAt ?? 0).compareTo(a.watchedAt ?? 0)),
          ];
          final items = [for (final e in lists[tab]) if (app.film(e.id) != null) e];
          final pad = MediaQuery.paddingOf(context);
          return RefreshIndicator(
            color: kBg,
            backgroundColor: kInk,
            edgeOffset: pad.top,
            onRefresh: app.syncLetterboxd,
            child: CustomScrollView(
              physics: const AlwaysScrollableScrollPhysics(parent: BouncingScrollPhysics()),
              slivers: [
                SliverToBoxAdapter(
                  child: Padding(
                    padding: EdgeInsets.fromLTRB(16, pad.top + 8, 16, 14),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Row(children: [
                        Text('Library', style: serif(40)),
                        const Spacer(),
                        if (tab == 0)
                          RoundButton(byRating ? Icons.star_rounded : Icons.schedule_rounded, byRating ? 'Sorted by rating' : 'Sorted by date',
                              size: 46, onTap: () => setState(() => byRating = !byRating)),
                        const SizedBox(width: 8),
                        RoundButton(Icons.search_rounded, 'Find a film', size: 46, onTap: () {
                          Navigator.of(context).push(MaterialPageRoute(builder: (_) => const SearchScreen()));
                        }),
                      ]),
                      const SizedBox(height: 14),
                      Row(children: [
                        for (final (i, icon, label) in [
                          (0, Icons.star_rounded, 'Rated'),
                          (1, Icons.bookmark_rounded, 'Watchlist'),
                          (2, Icons.visibility_rounded, 'Seen'),
                        ])
                          Padding(
                            padding: const EdgeInsets.only(right: 8),
                            child: Chip2('$label  ${lists[i].length}', icon: icon, active: tab == i, onTap: () => setState(() => tab = i)),
                          ),
                      ]),
                    ]),
                  ),
                ),
                if (items.isEmpty)
                  SliverFillRemaining(
                    hasScrollBody: false,
                    child: Padding(
                      padding: const EdgeInsets.only(bottom: 90),
                      child: lib.entries.isEmpty
                          ? Blank(Icons.movie_filter_outlined, 'Your films will live here',
                              action: 'Import Letterboxd', onAction: () => pickAndImportZip(context))
                          : const Blank(Icons.inbox_outlined, 'Nothing here yet'),
                    ),
                  )
                else
                  SliverPadding(
                    padding: EdgeInsets.fromLTRB(12, 0, 12, pad.bottom + 110),
                    sliver: SliverGrid.builder(
                      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: 3, childAspectRatio: 2 / 3, mainAxisSpacing: 8, crossAxisSpacing: 8),
                      itemCount: items.length,
                      itemBuilder: (context, i) => FilmTile(app.film(items[i].id)!, entry: items[i]),
                    ),
                  ),
              ],
            ),
          );
        },
      );
}

class FilmTile extends StatelessWidget {
  final Film film;
  final Entry? entry;
  const FilmTile(this.film, {super.key, this.entry});
  @override
  Widget build(BuildContext context) {
    final e = entry;
    return Semantics(
      button: true,
      label: '${film.label}${e?.rating != null ? ', rated ${e!.rating} stars' : ''}',
      child: GestureDetector(
        onTap: () {
          tick();
          showFilmSheet(context, film);
        },
        child: ExcludeSemantics(
          child: Stack(fit: StackFit.expand, children: [
            Poster(film.poster, label: film.title, radius: 12),
            if (e?.rating != null || e?.liked == true)
              Positioned(
                left: 0,
                right: 0,
                bottom: 0,
                child: Container(
                  padding: const EdgeInsets.fromLTRB(8, 18, 8, 7),
                  decoration: const BoxDecoration(
                    borderRadius: BorderRadius.vertical(bottom: Radius.circular(12)),
                    gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Colors.transparent, Color(0xD9000000)]),
                  ),
                  child: Row(children: [
                    if (e?.rating != null) Stars(e!.rating!, size: 13),
                    const Spacer(),
                    if (e?.liked == true) const Icon(Icons.favorite_rounded, size: 12, color: Color(0xFFFF7A6B)),
                  ]),
                ),
              ),
          ]),
        ),
      ),
    );
  }
}

/// Find any film on TMDB to rate it or put it on the watchlist.
class SearchScreen extends StatefulWidget {
  const SearchScreen({super.key});
  @override
  State<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends State<SearchScreen> {
  Timer? _debounce;
  List<Film>? _results;
  bool _busy = false;
  String _q = '';

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  void _search(String q) {
    _debounce?.cancel();
    _q = q.trim();
    if (_q.length < 2) {
      setState(() => _results = null);
      return;
    }
    _debounce = Timer(const Duration(milliseconds: 350), () async {
      final q = _q;
      setState(() => _busy = true);
      try {
        final r = await app.tmdb.search(q);
        if (mounted && q == _q) setState(() => _results = [for (final f in r) if (f.poster != null) f]);
      } catch (_) {
        if (mounted) setState(() => _results = []);
      } finally {
        if (mounted) setState(() => _busy = false);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final pad = MediaQuery.paddingOf(context);
    return Scaffold(
      body: Column(children: [
        Padding(
          padding: EdgeInsets.fromLTRB(10, pad.top + 8, 16, 8),
          child: Row(children: [
            RoundButton(Icons.arrow_back_rounded, 'Back', size: 46, onTap: () => Navigator.pop(context)),
            const SizedBox(width: 10),
            Expanded(
              child: TextField(
                autofocus: true,
                onChanged: _search,
                style: sans(18),
                cursorColor: kAccent,
                textInputAction: TextInputAction.search,
                decoration: InputDecoration(
                  hintText: 'Film title',
                  hintStyle: sans(18, color: kFaint),
                  filled: true,
                  fillColor: const Color(0x14FFFFFF),
                  contentPadding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(999), borderSide: BorderSide.none),
                  suffixIcon: _busy ? const Padding(padding: EdgeInsets.all(14), child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: kDim))) : null,
                ),
              ),
            ),
          ]),
        ),
        Expanded(
          child: _results == null
              ? const Blank(Icons.search_rounded, 'Rate or save any film')
              : _results!.isEmpty
                  ? const Blank(Icons.sentiment_dissatisfied_rounded, 'No film found')
                  : ListenableBuilder(
                      listenable: app,
                      builder: (context, _) => GridView.builder(
                        padding: EdgeInsets.fromLTRB(12, 8, 12, pad.bottom + 24),
                        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: 3, childAspectRatio: 2 / 3, mainAxisSpacing: 8, crossAxisSpacing: 8),
                        itemCount: _results!.length,
                        itemBuilder: (context, i) => FilmTile(_results![i], entry: app.lib[_results![i].id]),
                      ),
                    ),
        ),
      ]),
    );
  }
}
