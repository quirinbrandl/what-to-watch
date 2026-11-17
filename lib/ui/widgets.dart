import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';

import '../core/models.dart';
import '../core/tmdb.dart';

// ---------------------------------------------------------------- theme

const kBg = Color(0xFF08080A);
const kInk = Color(0xFFF4F1EA);
const kDim = Color(0xFFA29E96);
const kFaint = Color(0xFF5F5C57);
const kAccent = Color(0xFFFFC857);
const kCard = Color(0xFF151518);
const kLine = Color(0x1FFFFFFF);
const kDanger = Color(0xFFFF6B5E);

TextStyle sans(double size, {int w = 500, Color color = kInk, double? height, double spacing = 0}) => TextStyle(
      fontFamily: 'Manrope',
      fontSize: size,
      fontWeight: FontWeight.values[(w ~/ 100 - 1).clamp(0, 8)],
      fontVariations: [ui.FontVariation('wght', w.toDouble())],
      color: color,
      height: height,
      letterSpacing: spacing,
    );

TextStyle serif(double size, {Color color = kInk, bool italic = false, double height = 1.05}) => TextStyle(
      fontFamily: 'InstrumentSerif',
      fontSize: size,
      color: color,
      height: height,
      fontStyle: italic ? FontStyle.italic : FontStyle.normal,
      letterSpacing: -0.2,
    );

ThemeData appTheme() {
  final scheme = const ColorScheme.dark(
    primary: kAccent,
    onPrimary: Color(0xFF1B1300),
    secondary: kAccent,
    surface: kBg,
    onSurface: kInk,
    error: kDanger,
  );
  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    colorScheme: scheme,
    scaffoldBackgroundColor: kBg,
    fontFamily: 'Manrope',
    splashFactory: InkSparkle.splashFactory,
    textTheme: Typography.whiteMountainView.apply(fontFamily: 'Manrope', bodyColor: kInk, displayColor: kInk),
    sliderTheme: const SliderThemeData(
      activeTrackColor: kInk,
      inactiveTrackColor: Color(0x33FFFFFF),
      thumbColor: kInk,
      overlayColor: Color(0x22FFFFFF),
      trackHeight: 3,
      rangeThumbShape: RoundRangeSliderThumbShape(enabledThumbRadius: 9),
      thumbShape: RoundSliderThumbShape(enabledThumbRadius: 9),
    ),
    bottomSheetTheme: const BottomSheetThemeData(backgroundColor: Colors.transparent, surfaceTintColor: Colors.transparent),
    dialogTheme: DialogThemeData(
      backgroundColor: kCard,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(28)),
      titleTextStyle: serif(28),
      contentTextStyle: sans(15, color: kDim, height: 1.45),
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: const Color(0xFF26262B),
      contentTextStyle: sans(14),
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
    ),
  );
}

void tick() => HapticFeedback.selectionClick();
void thud() => HapticFeedback.mediumImpact();

void toast(BuildContext context, String text) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(text), duration: const Duration(seconds: 3)));
}

// ---------------------------------------------------------------- posters

/// A film poster. The art is the design, so this is used everywhere.
class Poster extends StatelessWidget {
  final String? path;
  final String label;
  final double radius;
  final String size;
  final BoxFit fit;
  const Poster(this.path, {super.key, this.label = '', this.radius = 12, this.size = 'w342', this.fit = BoxFit.cover});

  @override
  Widget build(BuildContext context) {
    Widget blank([bool failed = false]) => DecoratedBox(
          decoration: const BoxDecoration(
            gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [Color(0xFF1E1E23), Color(0xFF111114)]),
          ),
          child: failed || path == null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(8),
                    child: label.isEmpty
                        ? const Icon(Icons.movie_outlined, color: kFaint)
                        : Text(label, textAlign: TextAlign.center, maxLines: 4, overflow: TextOverflow.ellipsis, style: serif(15, color: kDim)),
                  ),
                )
              : const SizedBox.expand(),
        );
    return Semantics(
      label: label.isEmpty ? null : 'Poster: $label',
      image: true,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(radius),
        child: path == null
            ? blank()
            : CachedNetworkImage(
                imageUrl: Tmdb.img(path!, size),
                fit: fit,
                fadeInDuration: const Duration(milliseconds: 260),
                placeholder: (_, _) => blank(),
                errorWidget: (_, _, _) => blank(true),
              ),
      ),
    );
  }
}

final _palette = <String, Color>{};

/// Dominant colour of a poster, used to tint the surroundings.
Future<Color> posterColor(String? path) async {
  if (path == null) return const Color(0xFF3A3A44);
  final hit = _palette[path];
  if (hit != null) return hit;
  try {
    final scheme = await ColorScheme.fromImageProvider(provider: CachedNetworkImageProvider(Tmdb.img(path, 'w92')), brightness: Brightness.dark);
    return _palette[path] = scheme.primary;
  } catch (_) {
    return const Color(0xFF3A3A44);
  }
}

/// Rebuilds with the poster's dominant colour once it is known.
class PosterTint extends StatefulWidget {
  final String? path;
  final Widget Function(BuildContext, Color) builder;
  const PosterTint({super.key, required this.path, required this.builder});
  @override
  State<PosterTint> createState() => _PosterTintState();
}

class _PosterTintState extends State<PosterTint> {
  Color _c = const Color(0xFF3A3A44);
  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(PosterTint old) {
    super.didUpdateWidget(old);
    if (old.path != widget.path) _load();
  }

  void _load() {
    final p = widget.path;
    _c = _palette[p] ?? _c;
    posterColor(p).then((c) {
      if (mounted && widget.path == p && c != _c) setState(() => _c = c);
    });
  }

  @override
  Widget build(BuildContext context) => widget.builder(context, _c);
}

/// A slowly drifting, tilted wall of posters used as a living backdrop.
class PosterWall extends StatelessWidget {
  final List<String> posters;
  final double dim;
  const PosterWall(this.posters, {super.key, this.dim = 0.55});

  @override
  Widget build(BuildContext context) {
    if (posters.isEmpty) return const ColoredBox(color: kBg);
    const cols = 4;
    return ExcludeSemantics(
      child: Stack(fit: StackFit.expand, children: [
        ClipRect(
          child: OverflowBox(
            maxWidth: double.infinity,
            maxHeight: double.infinity,
            child: Transform.rotate(
              angle: -0.14,
              child: SizedBox(
                width: MediaQuery.sizeOf(context).width * 1.45,
                height: MediaQuery.sizeOf(context).height * 1.3,
                child: Row(children: [
                  for (var c = 0; c < cols; c++)
                    Expanded(
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 5),
                        child: _Drift(
                          items: [for (var i = c; i < posters.length; i += cols) posters[i]],
                          speed: 9.0 + 5 * ((c * 7) % 3),
                          reverse: c.isOdd,
                        ),
                      ),
                    ),
                ]),
              ),
            ),
          ),
        ),
        DecoratedBox(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              stops: const [0, 0.45, 0.8, 1],
              colors: [kBg.withValues(alpha: dim), kBg.withValues(alpha: dim * 0.55), kBg.withValues(alpha: 0.94), kBg],
            ),
          ),
        ),
      ]),
    );
  }
}

class _Drift extends StatefulWidget {
  final List<String> items;
  final double speed;
  final bool reverse;
  final Axis axis;
  final double gap;
  const _Drift({required this.items, required this.speed, this.reverse = false, this.axis = Axis.vertical, this.gap = 10});
  @override
  State<_Drift> createState() => _DriftState();
}

class _DriftState extends State<_Drift> with SingleTickerProviderStateMixin {
  final _c = ScrollController();
  late final Ticker _t;
  Duration _last = Duration.zero;

  @override
  void initState() {
    super.initState();
    _t = createTicker((now) {
      final dt = (now - _last).inMicroseconds / 1e6;
      _last = now;
      if (_c.hasClients && dt < 0.2) _c.jumpTo(_c.offset + widget.speed * dt);
    })
      ..start();
  }

  @override
  void dispose() {
    _t.dispose();
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final items = widget.items;
    if (items.isEmpty) return const SizedBox();
    final vertical = widget.axis == Axis.vertical;
    return ListView.builder(
      controller: _c,
      reverse: widget.reverse,
      scrollDirection: widget.axis,
      physics: const NeverScrollableScrollPhysics(),
      padding: EdgeInsets.zero,
      itemBuilder: (_, i) => Padding(
        padding: vertical ? EdgeInsets.only(bottom: widget.gap) : EdgeInsets.only(right: widget.gap),
        child: AspectRatio(aspectRatio: 2 / 3, child: Poster(items[i % items.length], radius: 10, size: 'w185')),
      ),
    );
  }
}

/// A horizontal ribbon of posters gliding by (wait screen, onboarding).
class PosterRibbon extends StatelessWidget {
  final List<String> posters;
  final double height;
  final double speed;
  final bool reverse;
  const PosterRibbon(this.posters, {super.key, this.height = 150, this.speed = 26, this.reverse = false});
  @override
  Widget build(BuildContext context) => SizedBox(
        height: height,
        child: ExcludeSemantics(child: _Drift(items: posters, speed: speed, reverse: reverse, axis: Axis.horizontal, gap: 10)),
      );
}

// ---------------------------------------------------------------- small parts

class Glass extends StatelessWidget {
  final Widget child;
  final double radius;
  final Color color;
  final EdgeInsetsGeometry padding;
  const Glass({super.key, required this.child, this.radius = 26, this.color = const Color(0xB3141417), this.padding = EdgeInsets.zero});
  @override
  Widget build(BuildContext context) => ClipRRect(
        borderRadius: BorderRadius.circular(radius),
        child: BackdropFilter(
          filter: ui.ImageFilter.blur(sigmaX: 24, sigmaY: 24),
          child: DecoratedBox(
            decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(radius), border: Border.all(color: kLine)),
            child: Padding(padding: padding, child: child),
          ),
        ),
      );
}

/// Read-only star rating with half stars.
class Stars extends StatelessWidget {
  final double value;
  final double size;
  final Color color;
  const Stars(this.value, {super.key, this.size = 14, this.color = kAccent});
  @override
  Widget build(BuildContext context) => Semantics(
        label: '$value stars',
        child: ExcludeSemantics(
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            for (var i = 1; i <= 5; i++)
              if (value >= i)
                Icon(Icons.star_rounded, size: size, color: color)
              else if (value >= i - 0.5)
                Icon(Icons.star_half_rounded, size: size, color: color)
          ]),
        ),
      );
}

/// Half-star rating input: tap or drag across the stars.
class StarInput extends StatelessWidget {
  final double? value;
  final ValueChanged<double?> onChanged;
  final double size;
  const StarInput({super.key, required this.value, required this.onChanged, this.size = 44});

  @override
  Widget build(BuildContext context) {
    final v = value ?? 0;
    void set(double dx) {
      final n = ((dx / (size * 5)) * 10).ceil().clamp(1, 10) / 2;
      if (n != value) {
        tick();
        onChanged(n);
      }
    }

    return Semantics(
      label: 'Your rating',
      value: value == null ? 'not rated' : '$value stars',
      slider: true,
      onIncrease: () => onChanged(math.min(5, v + 0.5)),
      onDecrease: () => onChanged(v <= 0.5 ? null : v - 0.5),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapUp: (d) {
          final n = ((d.localPosition.dx / (size * 5)) * 10).ceil().clamp(1, 10) / 2;
          tick();
          onChanged(n == value ? null : n); // tapping the same value clears it
        },
        onHorizontalDragUpdate: (d) => set(d.localPosition.dx),
        child: SizedBox(
          width: size * 5,
          height: size + 8,
          child: Row(children: [
            for (var i = 1; i <= 5; i++)
              Icon(
                v >= i ? Icons.star_rounded : (v >= i - 0.5 ? Icons.star_half_rounded : Icons.star_outline_rounded),
                size: size,
                color: v >= i - 0.5 ? kAccent : kFaint,
              )
          ]),
        ),
      ),
    );
  }
}

/// Round icon button with a generous touch target and a screen-reader label.
class RoundButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final VoidCallback? onTap;
  final bool active;
  final double size;
  final Color? tint;
  final bool showLabel;
  const RoundButton(this.icon, this.label, {super.key, this.onTap, this.active = false, this.size = 54, this.tint, this.showLabel = false});

  @override
  Widget build(BuildContext context) {
    final c = active ? (tint ?? kAccent) : kInk;
    return Semantics(
      button: true,
      label: label,
      toggled: active,
      child: Tooltip(
        message: label,
        excludeFromSemantics: true,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Material(
            color: active ? c.withValues(alpha: 0.16) : const Color(0x1AFFFFFF),
            shape: CircleBorder(side: BorderSide(color: active ? c.withValues(alpha: 0.5) : kLine)),
            clipBehavior: Clip.antiAlias,
            child: InkWell(
              onTap: onTap == null
                  ? null
                  : () {
                      tick();
                      onTap!();
                    },
              child: SizedBox(width: size, height: size, child: Icon(icon, color: onTap == null ? kFaint : c, size: size * 0.44)),
            ),
          ),
          if (showLabel) ...[const SizedBox(height: 6), ExcludeSemantics(child: Text(label, style: sans(11, color: kDim, w: 600)))],
        ]),
      ),
    );
  }
}

/// The primary call to action.
class BigButton extends StatelessWidget {
  final String label;
  final IconData? icon;
  final VoidCallback? onTap;
  final bool busy;
  final Color color;
  final Color ink;
  const BigButton(this.label, {super.key, this.icon, this.onTap, this.busy = false, this.color = kInk, this.ink = const Color(0xFF0B0B0E)});
  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        label: label,
        enabled: onTap != null && !busy,
        child: Material(
          color: onTap == null ? const Color(0x33FFFFFF) : color,
          borderRadius: BorderRadius.circular(999),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: busy || onTap == null
                ? null
                : () {
                    thud();
                    onTap!();
                  },
            child: SizedBox(
              height: 58,
              child: Center(
                child: busy
                    ? SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.4, color: ink))
                    : ExcludeSemantics(
                        child: Row(mainAxisSize: MainAxisSize.min, children: [
                          if (icon != null) ...[Icon(icon, color: ink, size: 22), const SizedBox(width: 10)],
                          Text(label, style: sans(16.5, w: 700, color: ink)),
                        ]),
                      ),
              ),
            ),
          ),
        ),
      );
}

/// Compact selectable chip.
class Chip2 extends StatelessWidget {
  final String label;
  final IconData? icon;
  final bool active;
  final bool negative;
  final VoidCallback? onTap;
  final Widget? leading;
  const Chip2(this.label, {super.key, this.icon, this.active = false, this.negative = false, this.onTap, this.leading});
  @override
  Widget build(BuildContext context) {
    final fg = negative ? kDanger : (active ? const Color(0xFF0B0B0E) : kInk);
    return Semantics(
      button: true,
      label: negative ? 'Not $label' : label,
      selected: active,
      child: Material(
        color: negative ? kDanger.withValues(alpha: 0.14) : (active ? kInk : const Color(0x14FFFFFF)),
        shape: StadiumBorder(side: BorderSide(color: negative ? kDanger.withValues(alpha: 0.5) : (active ? kInk : kLine))),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap == null
              ? null
              : () {
                  tick();
                  onTap!();
                },
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 44),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14),
              child: ExcludeSemantics(
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  if (leading != null) ...[leading!, const SizedBox(width: 8)],
                  if (icon != null) ...[Icon(icon, size: 17, color: fg), const SizedBox(width: 7)],
                  Text(label,
                      style: sans(13.5, w: 600, color: fg).copyWith(decoration: negative ? TextDecoration.lineThrough : null, decorationColor: kDanger)),
                ]),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class ProviderLogo extends StatelessWidget {
  final String? logo;
  final String name;
  final double size;
  const ProviderLogo(this.logo, this.name, {super.key, this.size = 34});
  @override
  Widget build(BuildContext context) => Semantics(
        label: name,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(size * 0.24),
          child: logo == null
              ? Container(width: size, height: size, color: const Color(0x22FFFFFF), alignment: Alignment.center, child: Text(name.characters.first, style: sans(13, w: 700)))
              : CachedNetworkImage(imageUrl: Tmdb.img(logo!, 'w92'), width: size, height: size, fit: BoxFit.cover),
        ),
      );
}

/// TMDB user score as a ring.
class ScoreRing extends StatelessWidget {
  final Film film;
  final double size;
  const ScoreRing(this.film, {super.key, this.size = 46});
  @override
  Widget build(BuildContext context) {
    final v = film.votes > 0 ? film.vote : 0.0;
    final c = v >= 7 ? const Color(0xFF5BD68A) : (v >= 5.5 ? kAccent : kDanger);
    return Semantics(
      label: 'TMDB user score ${(v * 10).round()} percent',
      child: ExcludeSemantics(
        child: SizedBox(
          width: size,
          height: size,
          child: Stack(alignment: Alignment.center, children: [
            SizedBox.expand(child: CircularProgressIndicator(value: v / 10, strokeWidth: 3.2, color: c, backgroundColor: const Color(0x22FFFFFF), strokeCap: StrokeCap.round)),
            Text(film.votes > 0 ? '${(v * 10).round()}' : '–', style: sans(size * 0.32, w: 700)),
          ]),
        ),
      ),
    );
  }
}

/// Designed empty / error state: an icon, a few words, one action.
class Blank extends StatelessWidget {
  final IconData icon;
  final String title;
  final String? action;
  final VoidCallback? onAction;
  const Blank(this.icon, this.title, {super.key, this.action, this.onAction});
  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(36),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Container(
              width: 84,
              height: 84,
              decoration: const BoxDecoration(shape: BoxShape.circle, color: Color(0x12FFFFFF)),
              child: Icon(icon, size: 34, color: kDim),
            ),
            const SizedBox(height: 22),
            Text(title, textAlign: TextAlign.center, style: serif(26, color: kInk)),
            if (action != null) ...[
              const SizedBox(height: 22),
              SizedBox(width: 220, child: BigButton(action!, onTap: onAction)),
            ],
          ]),
        ),
      );
}

String runtimeLabel(int? m) => m == null || m <= 0 ? '' : (m >= 60 ? '${m ~/ 60}h ${m % 60}m' : '${m}m');
