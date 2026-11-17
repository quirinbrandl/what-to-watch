# Privacy Policy

**What to Watch** is a local-first app. There is no What to Watch server, no account with us, no analytics, no advertising and no tracking. We, the developers, never receive any of your data.

## What is stored, and where

Everything stays on your device, in the app's private storage:

- your library: ratings, watched films, watchlist, "not for me" marks, and what you imported from Letterboxd
- your settings: region, streaming services, filters, chosen model
- a cache of public film information and poster images
- your sign-in credentials (ChatGPT session tokens or an OpenAI API key), kept in the operating system's secure credential storage (Android Keystore / iOS Keychain)

Uninstalling the app, or **Settings → Delete everything**, removes all of it. Backups you export contain your library and settings, never credentials.

## What leaves your device

The app talks directly to three services, and only to do what you asked for:

- **OpenAI** — to create recommendations, the app sends your request (mood text, filters) and the film titles and ratings from your library to OpenAI's API, using your own ChatGPT plan or your own API key. Signing in happens on OpenAI's website in your browser; the app never sees your password. OpenAI handles this data under its own terms and privacy policy.
- **TMDB** (The Movie Database) — to look up films, posters, scores and where they can be streamed. These requests contain film titles or IDs and your region, not your identity. Streaming availability data is provided by JustWatch through TMDB.
- **Letterboxd** — if you enter a username or import an export, the app reads that profile's public RSS feed to pick up new diary entries. Nothing is ever written to Letterboxd.

No other network connections are made.

## Your choices

- You can use the app without Letterboxd.
- You can sign out at any time; the app then revokes its ChatGPT session. You can also disconnect the app in your ChatGPT settings.
- You can export, restore or delete all data in Settings.

## Children

The app is not directed at children under 13.

## Changes and contact

Changes to this policy are published with the app's source code. Questions and requests: open an issue in the project's public repository.
