import 'package:material_ui/material_ui.dart';

import '../app/state.dart';
import '../core/letterboxd.dart';
import 'settings.dart';
import 'widgets.dart';

/// Three quick steps: sign in → Letterboxd → where you watch.
class Onboarding extends StatefulWidget {
  final VoidCallback onDone;
  const Onboarding({super.key, required this.onDone});
  @override
  State<Onboarding> createState() => _OnboardingState();
}

class _OnboardingState extends State<Onboarding> {
  int step = 0;
  bool busy = false;
  List<String> wall = [];
  final _user = TextEditingController();

  @override
  void initState() {
    super.initState();
    if (app.hasLlm) step = 1;
    _loadWall();
  }

  @override
  void dispose() {
    _user.dispose();
    super.dispose();
  }

  Future<void> _loadWall() async {
    try {
      final lists = await Future.wait([app.tmdb.popularTop(), app.tmdb.popularTop(page: 2), app.tmdb.trending()]);
      final posters = [for (final l in lists) for (final f in l) if (f.poster != null) f.poster!]..shuffle();
      if (mounted) setState(() => wall = posters);
    } catch (_) {}
  }

  void _next() => setState(() => step++);

  Future<void> _signIn() async {
    setState(() => busy = true);
    try {
      await app.signIn();
      if (mounted) await showPlanWelcome(context);
      if (mounted) _next();
    } catch (e) {
      if (mounted) toast(context, '$e');
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final pad = MediaQuery.paddingOf(context);
    final keyboard = MediaQuery.viewInsetsOf(context).bottom;
    return Scaffold(
      resizeToAvoidBottomInset: false,
      body: ListenableBuilder(
        listenable: app,
        builder: (context, _) => Stack(fit: StackFit.expand, children: [
          PosterWall(wall, dim: step == 0 ? 0.25 : 0.7),
          Padding(
            padding: EdgeInsets.fromLTRB(24, pad.top + 16, 24, (keyboard > 0 ? keyboard : pad.bottom) + 20),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                for (var i = 0; i < 3; i++)
                  AnimatedContainer(
                    duration: const Duration(milliseconds: 250),
                    margin: const EdgeInsets.symmetric(horizontal: 3),
                    width: i == step ? 22 : 6,
                    height: 6,
                    decoration: BoxDecoration(color: i <= step ? kInk : const Color(0x44FFFFFF), borderRadius: BorderRadius.circular(3)),
                  ),
              ]),
              const Spacer(),
              AnimatedSwitcher(
                duration: const Duration(milliseconds: 320),
                switchInCurve: Curves.easeOutCubic,
                transitionBuilder: (c, a) => FadeTransition(
                  opacity: a,
                  child: SlideTransition(position: Tween(begin: const Offset(0, 0.06), end: Offset.zero).animate(a), child: c),
                ),
                child: KeyedSubtree(key: ValueKey(step), child: [_stepSignIn, _stepLetterboxd, _stepRegion][step](context)),
              ),
            ]),
          ),
        ]),
      ),
    );
  }

  Widget _stepSignIn(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
        Text('What\nto Watch', style: serif(64, italic: true, height: 0.95)),
        const SizedBox(height: 34),
        BigButton('Continue with ChatGPT', onTap: _signIn, busy: busy),
        const SizedBox(height: 6),
        Center(
          child: busy
              ? TextButton(
                  onPressed: () {
                    app.auth.cancelSignIn();
                  },
                  child: Text('Cancel', style: sans(14, color: kDim, w: 600)))
              : TextButton(
                  onPressed: () async {
                    await apiKeyFlow(context);
                    if (app.hasLlm && mounted) _next();
                  },
                  child: Text('Use an OpenAI API key', style: sans(14, color: kDim, w: 600)),
                ),
        ),
      ]);

  Widget _stepLetterboxd(BuildContext context) {
    final lib = app.lib;
    final imported = lib.lbImportAt != null;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
      Text(imported ? 'Got your films' : 'Bring your\nLetterboxd', style: serif(48)),
      const SizedBox(height: 12),
      if (imported)
        Text('${lib.rated.length} ratings  ·  ${lib.watched.length} seen  ·  ${lib.watchlist.length} watchlist', style: sans(15, color: kDim))
      else
        Text('Settings → Data → Export on letterboxd.com', style: sans(14, color: kDim)),
      const SizedBox(height: 28),
      if (imported)
        BigButton('Continue', onTap: _next)
      else ...[
        BigButton('Import export ZIP', icon: Icons.folder_zip_outlined, onTap: () async {
          if (await pickAndImportZip(context) && mounted) setState(() {});
        }),
        const SizedBox(height: 12),
        TextField(
          controller: _user,
          style: sans(16),
          cursorColor: kAccent,
          autocorrect: false,
          textInputAction: TextInputAction.done,
          onSubmitted: (_) => _useUsername(),
          decoration: InputDecoration(
            hintText: 'or just your username',
            hintStyle: sans(16, color: kFaint),
            filled: true,
            fillColor: const Color(0x1AFFFFFF),
            contentPadding: const EdgeInsets.symmetric(horizontal: 22, vertical: 17),
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(999), borderSide: BorderSide.none),
            suffixIcon: IconButton(tooltip: 'Use username', icon: const Icon(Icons.arrow_forward_rounded, color: kInk), onPressed: _useUsername),
          ),
        ),
        Center(child: TextButton(onPressed: _next, child: Text('Skip', style: sans(14, color: kDim, w: 600)))),
      ],
    ]);
  }

  void _useUsername() {
    if (cleanUsername(_user.text) == null) {
      toast(context, 'That does not look like a username');
      return;
    }
    FocusScope.of(context).unfocus();
    app.setUsername(_user.text);
    _next();
  }

  Widget _stepRegion(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
        Text('Where do\nyou watch?', style: serif(48)),
        const SizedBox(height: 18),
        Align(
          alignment: Alignment.centerLeft,
          child: Chip2(kRegions[app.settings.region] ?? app.settings.region, icon: Icons.public_rounded, onTap: () => pickRegion(context)),
        ),
        const SizedBox(height: 18),
        ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.36),
          child: const SingleChildScrollView(child: ServicesGrid()),
        ),
        const SizedBox(height: 26),
        BigButton(app.hasLlm ? 'Show me films' : 'Done', icon: Icons.auto_awesome_rounded, color: kAccent, ink: const Color(0xFF1B1300), onTap: () {
          app.settings.onboarded = true;
          app.changed();
          widget.onDone();
        }),
      ]);
}
