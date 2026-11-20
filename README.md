# WhatToWatch

A poster-first, local-first film recommender for Android (iOS-ready), built with React Native.

Tell it your mood, set a few filters and swipe through full-screen posters picked for *your* taste. Tap a poster to flip it and see why it fits you.

- **Personal:** recommends from your ratings. Import your Letterboxd export once; new diary entries sync automatically.
- **Honest:** every film is a real TMDB title, hard filters are enforced by code, and the "why" only refers to films you actually rated.
- **Local-first:** no backend, no account with us, no analytics. Your library lives on your phone. See [PRIVACY.md](PRIVACY.md).
- **Bring your own model:** "Continue with ChatGPT" uses your ChatGPT plan; an OpenAI or Claude API key works too (Settings → Advanced).
- **Per search, not per account:** the streaming services are a filter like any other — Disney+ tonight with friends, only Netflix tomorrow. The country is guessed from the phone's time zone (no location access, no extra network call) and can be changed next to the services.
- **Nothing found twice:** every search is kept on the phone (the last 20). "Your searches" on the home screen brings one back instantly, with its films and their order.

## How recommendations are made

```
your ratings ─► LLM: which films would I love? ─► TMDB lookup + filters (code) ─► LLM: how would I rate each? ─► sorted by that rating ─► feed
                      60 titles                       about 58 real films              a predicted rating per film
```

1. **Propose.** The LLM gets your ratings in three plain groups (loved, liked, did not like) and one sentence: recommend 60 films I have not rated that I would love.
2. **Look up and filter, in code.** Every title is looked up on TMDB while the answer is still being written; titles that do not exist are dropped. `rejectReason` in `src/core/engine/request.ts` enforces the filters on full TMDB records: year, runtime, genres, language, streaming availability, watched, dismissed, already shown. Nothing reaches the feed without passing it.
3. **Rate.** A second call predicts the rating you would give each film that is left. The list is sorted by that rating; films predicted below 3★ are dropped.

The questions are a few plain sentences (`src/core/engine/prompts.ts`), and that is on purpose: in the experiments below, longer instructions, a taste model on the device, TMDB's own lists and an agent with lookups all scored the same or worse.

**Everything else adds one line or one sentence, and nothing when it is not used:**

- *Typed request* ("In the mood for…") and *more like this*: one line in both questions.
- *Filters*: one sentence each in question 1, so the LLM wastes fewer ideas; the code check stays the authority. When the filters leave fewer than 30 of the LLM's ideas, TMDB adds well-rated films that pass them, and question 2 rates those too.
- *Mainstream ↔ niche dial*: one sentence in question 1; the middle position says nothing.
- *New releases* (off by default): the LLM knows no film released after mid-2024. With this option, about 30 well-rated newer films come from TMDB and a separate call predicts your rating from their facts (genre, director, cast, plot), while the two main questions run. They are woven into the list, best predicted first: one whose rating puts it near the top goes there, and otherwise at least every fourth film is a new release.

**Reasons.** The feed scrolls through the whole list without waiting. Why a film fits is written a few films at a time, one batch ahead of where you are (`Recommender.explain`). A reason may only cite your films through tags (`[L12]`); `validateWhy` checks every tag against your library (rated ≥ 3.5★) and rejects star claims. Reasons that fail fall back to plain facts. Only at the end of the list does "More" start a new round, which is told what it already proposed.

While you wait, the screen shows what the engine is doing, not a canned animation (`src/core/wall.ts`, `src/ui/Wait.tsx`): the wall of posters starts with your own films, every film the LLM names takes a tile as soon as TMDB has found it, tiles go dark as the predicted ratings stream in, and the best films light up before the feed opens. The progress bar runs on how long each stage took in your last searches.

**Backgrounds.** Behind each poster the feed shows a scene from the film. TMDB's main "backdrop" is often poster artwork without the title (13 of 21 films checked by eye), and nothing in its data tells the two apart. So one small vision call per batch of films looks at up to five textless backdrops per film and picks a real scene (`src/core/engine/scenes.ts`; about 10 s and 3,600 input tokens for 8 films at low detail, 21 of 21 real scenes in the same check). The choice is saved with the film; until it arrives, and for films without a usable image, the poster is shown as a soft glow.

### Evaluation

The engine was chosen by experiment (`tool/lab/`, see its README): 200 people from the public MovieLens data, 30% of each person's ratings hidden, 24 recommendations, +1 for each hidden film the person rated 4★ or higher and −1 for each below 3★. Engines were developed on 40 people and confirmed once on 80 others.

On those 80 people (model `gpt-6.2-sol`, low reasoning effort; "at equal fame" corrects for the fact that famous films are in everybody's history):

| Engine | Score at equal fame | Raw score | LLM time | Tokens |
|---|---|---|---|---|
| **This engine, run from the app's code** | **6.6** | **7.0** | **39 s** | **4.7k** |
| The same two questions in the lab | 6.7 | 7.0 | 39 s | 4.7k |
| Question 1 alone | 6.3 | 6.5 | 27 s | 2.3k |
| The pipeline this replaced (taste model, three sources, judge, blend) | 5.5 | 4.7 | 98 s | 11.4k |
| A smaller model (`gpt-6-luna`) with question 1 | 3.9 | 3.6 | 18 s | |

With no request, no filter and the dial in the middle, the app sends the tested questions word for word (a unit test pins the wording). The first row is the app's engine run through the lab: for 71 of the 80 people it returned exactly the lab's 24 films.

What this test cannot see: whether a film the person never rated would have been a good discovery, and anything about typed requests, filters, the dial, new releases or the reasons. Those features were checked by hand (the filter holds, the request changes the list), not measured.

```sh
npm run eval -- signin                                   # ChatGPT sign-in for the command line
npx tsx tool/lab/cli.ts run --engine app --name my-run --users dev --set model=gpt-6.2-sol
```

## Letterboxd

- **ZIP import:** get the file on the Letterboxd website (sign in at letterboxd.com → Settings → Data → Export your data; the Letterboxd apps have no export) and drop in the whole ZIP. The app finds `ratings.csv`, `watched.csv`, `watchlist.csv`, `diary.csv`, `reviews.csv`, `likes/films.csv`, favourite lists and `profile.csv` (username) by itself and matches every film to TMDB by title and year. Series that Letterboxd lists are not films on TMDB and stay unmatched. Before importing, the app asks whether the Letterboxd watchlist should come in too; without it, films that are only on the watchlist are left out.
- **RSS sync:** on every app start, on return to the app and on pull-to-refresh, the app reads `letterboxd.com/<user>/rss/` and merges new diary entries.
- **Rules for merging** (`src/core/models.ts`, `applyRss` in `src/core/letterboxd.ts`):
  - Letterboxd values and in-app values are stored separately; for each field **the latest change wins**.
  - Rated ⇒ watched. Watched ⇒ off the watchlist.
  - A ZIP import replaces everything that came from Letterboxd and keeps everything you did in the app.
  - Feed items are remembered by id, so duplicates change nothing; an edited entry is applied again; each watch date counts once (rewatches).
- **Limits:** the feed holds the 50 most recent *diary* entries. Films you rate without logging them, and watchlist changes, only arrive with the next ZIP import. If more than 50 entries were logged since the last sync, Settings tells you to import a fresh ZIP. Nothing is ever written to Letterboxd (it has no public write API).

## Run it

Requirements: Node 22+, JDK 17 or 21, Android SDK.

```sh
npm install
npm test                      # core logic (Node test runner)
npm run typecheck

npx expo start                # dev server
cd android && ./gradlew :app:assembleDebug && adb install -r app/build/outputs/apk/debug/app-debug.apk

npm run phone                 # latest main as a release build onto the phone on USB, data kept
```

Release builds, signing and the Play Store listing: [docs/play-store.md](docs/play-store.md).

## Project layout

```
src/core/        platform-neutral TypeScript, shared by the app and the engine lab
  engine/        request + hard filters, the questions for the LLM, recommender, scene picking
  auth.ts        Sign in with ChatGPT (PKCE, loopback redirect, ID-token check, rotating refresh)
  llm.ts         streaming Responses API client (OpenAI) and the interface the engine uses
  claude.ts      Claude client on the Anthropic SDK, for a Claude API key
  letterboxd.ts  ZIP import, TMDB matching, RSS sync
  tmdb.ts        TMDB client and film cache
  wall.ts        what the wait screen's poster wall shows, without the drawing
src/app/         device bindings and app state (secure storage, files, stores)
src/ui/          screens and components
modules/loopback-auth/   native 127.0.0.1 listener for the sign-in redirect (Kotlin, Swift)
tool/            the engine lab (lab/), command-line sign-in, icon drawing (make-icons.sh)
android/         the Android project (committed; see docs/play-store.md)
```

## Sign in with ChatGPT

The app follows OpenAI's [token-sharing flow for open-source apps](https://developers.openai.com/siwc/token-sharing-open-source): authorization code with PKCE, a loopback redirect on `127.0.0.1`, dynamic client registration on first sign-in, ID-token signature check against OpenAI's keys, and rotating refresh tokens. Tokens are stored in the Android Keystore / iOS Keychain and never written to logs or backups. A native module keeps the loopback listener alive while the app sits behind the browser.

## Credits

- Film data and images: [TMDB](https://www.themoviedb.org). This product uses the TMDB API but is not endorsed or certified by TMDB. The read-only TMDB token in `src/core/tmdb.ts` is embedded on purpose so the app works without a TMDB account; it only grants access to public data.
- Streaming availability: JustWatch, via TMDB.
- Fonts: Anton and Manrope (SIL Open Font License).

## License

MIT, see [LICENSE](LICENSE).
