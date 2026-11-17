import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';

import 'app/state.dart';
import 'ui/home.dart';
import 'ui/onboarding.dart';
import 'ui/widgets.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
    statusBarColor: Colors.transparent,
    systemNavigationBarColor: Colors.transparent,
    systemNavigationBarContrastEnforced: false,
    statusBarIconBrightness: Brightness.light,
    systemNavigationBarIconBrightness: Brightness.light,
  ));
  LicenseRegistry.addLicense(() async* {
    yield LicenseEntryWithLineBreaks(['Instrument Serif'], await rootBundle.loadString('assets/fonts/InstrumentSerif-OFL.txt'));
    yield LicenseEntryWithLineBreaks(['Manrope'], await rootBundle.loadString('assets/fonts/Manrope-OFL.txt'));
  });
  runApp(const WhatToWatch());
  app.init();
}

class WhatToWatch extends StatelessWidget {
  const WhatToWatch({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'What to Watch',
        debugShowCheckedModeBanner: false,
        theme: appTheme(),
        home: const Root(),
      );
}

class Root extends StatefulWidget {
  const Root({super.key});
  @override
  State<Root> createState() => _RootState();
}

class _RootState extends State<Root> with WidgetsBindingObserver {
  bool _fresh = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /// Every time the app comes to the front, check Letterboxd for new entries.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && app.ready && !app.auth.signingIn) app.syncLetterboxd();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: app,
        builder: (context, _) {
          if (!app.ready) return const ColoredBox(color: kBg, child: SizedBox.expand());
          if (!app.settings.onboarded) {
            return Onboarding(key: const ValueKey('onboarding'), onDone: () => setState(() => _fresh = true));
          }
          return Shell(key: const ValueKey('shell'), autoRun: _fresh && app.hasLlm);
        },
      );
}
