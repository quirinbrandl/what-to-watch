# Shipping to Google Play

## Build

```sh
npm install
cd android
./gradlew bundleRelease     # app/build/outputs/bundle/release/app-release.aab  (upload this)
./gradlew assembleRelease   # app/build/outputs/apk/release/app-release.apk     (sideloading)
```

Use JDK 17 or 21 (`JAVA_HOME`) and set `ANDROID_HOME` to the Android SDK.

Release builds are signed with the keystore described in `android/key.properties` (git-ignored):

```properties
storeFile=upload-keystore.jks          # relative to android/
storePassword=…
keyAlias=upload
keyPassword=…
```

Create your own upload key once and **back it up** (Play App Signing keeps the real app key, this one only uploads):

```sh
keytool -genkeypair -v -keystore android/upload-keystore.jks -storetype JKS \
  -keyalg RSA -keysize 2048 -validity 10000 -alias upload
```

Without `key.properties` the release build is signed with the debug key, so it can be installed for testing but not uploaded.

Before the first upload: pick your final application id (`applicationId` and `namespace` in `android/app/build.gradle`, `android.package` and `scheme` in `app.json`, the `<data android:scheme>` in the manifest and `AUTH_RETURN_URL` in `src/app/platform.ts`; currently `dev.whattowatch.app`). It can never change after publishing. Bump `versionCode`/`versionName` in `android/app/build.gradle` for every upload.

The `android/` folder is committed and edited by hand (signing, trimmed permissions). Do not run `expo prebuild --clean`, which would regenerate it.

## Store listing

- **App name:** WhatToWatch
- **Short description (80):** Film picks that fit your taste. Posters first. Your data stays on your phone.
- **Full description:**
  WhatToWatch finds tonight's film. Tell it your mood, set a few filters, and swipe through full-screen posters picked for your personal taste. Flip a poster to see why it fits you.

  • Learns from your ratings — import your Letterboxd export and keep it in sync automatically
  • Mood prompt, genres, years, length, language, familiar ↔ obscure
  • Only films on the streaming services you pick for tonight, if you like
  • Your recent searches stay on the phone, ready to open again
  • Rate, save and dismiss films in the app
  • Local-first: no account with us, no server, no analytics, no ads. Your library never leaves your phone except to create your recommendations
  • Open source (MIT)

  Recommendations use your own ChatGPT plan via Sign in with ChatGPT, or your own OpenAI or Claude API key.
  Film data and images from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB. Streaming availability by JustWatch.
- **Category:** Entertainment
- **Privacy policy URL:** host `PRIVACY.md` (e.g. GitHub Pages or the raw file in the public repository) and paste the link.
- **Graphics:** icon `assets/icon/icon.png` (export at 512×512), screenshots from a device (1080×2400), feature graphic 1024×500.

## Data safety form

| Question | Answer |
|---|---|
| Does the app collect or share user data? | **No data collected by the developer.** Nothing is sent to developer-owned servers. |
| Data sent off device | To create recommendations, ratings/titles and the request text go from the device straight to OpenAI or Anthropic (whichever the user set up) under the user's own account; film look-ups go to TMDB; a public RSS feed is read from Letterboxd. Under Play's definitions this is user-initiated transfer to services the user chose, not collection by the developer — declare it in the listing text and privacy policy as above. |
| Is data encrypted in transit? | Yes (HTTPS only). |
| Can users request deletion? | Yes, in-app: Settings → Delete everything. |
| Account creation | No app account. Optional sign-in with the user's ChatGPT account. |

## Other declarations

- **Ads:** none. **In-app purchases:** none.
- **Content rating:** film posters and descriptions of all kinds can appear (adult-flagged titles are filtered out); answer the questionnaire accordingly (user-generated content: no).
- **Target audience:** 13+ (not directed at children).
- **Permissions:** `INTERNET`, `ACCESS_NETWORK_STATE` and `VIBRATE` (haptics). No storage, location, contacts or notification permissions.
- **TMDB:** attribution lives in Settings → About, as TMDB's terms require. The embedded TMDB token is read-only.
- **OpenAI:** the sign-in button label, first-run notice and "Manage usage" link follow the Sign in with ChatGPT UI guidelines.

## iOS later

The app is React Native (Expo modules), so iOS needs no rewrite: run `npx expo prebuild --platform ios`, set the signing team in Xcode and build. The native sign-in listener has a Swift implementation (`modules/loopback-auth/ios`) that mirrors the Android one but has not been run on a device yet.
