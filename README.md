# WhatToWatch

A poster-first, local-first film recommender for Android (iOS-ready), built with React Native.

Tell it your mood, set a few filters and swipe through full-screen posters picked for *your* taste. Tap a poster to flip it and see why it fits you.

- **Personal:** learns from your ratings, watched films and watchlist. Import your Letterboxd export once; new diary entries sync automatically.
- **Honest:** every film is a real TMDB title, hard filters are enforced by code, and the "why" only refers to films you actually rated.
- **Local-first:** no backend, no account with us, no analytics. Your library lives on your phone. See [PRIVACY.md](PRIVACY.md).
- **Bring your own model:** "Continue with ChatGPT" uses your ChatGPT plan; an OpenAI API key works too (Settings → Advanced).

## How recommendations are made

```
taste model ─┐
LLM scouting ─┼─► candidate pool ─► hard filters (code) ─► LLM judge ─► blend ─► diversify ─► feed
TMDB graph  ──┤        ~300–500 films        ~90 with full details      ~36          batches of 8
TMDB discover ┘
```

1. **Taste model** (`src/core/engine/taste.ts`, runs on the device). How much you like each genre, theme, director, actor, decade and language; your most similar rated films; and TMDB's recommendation graph around your library. A non-negative ridge regression, fitted on leave-one-out features of your own ratings, stacks these into a predicted rating.
2. **Candidates** from three sources: the LLM proposes films after reading your full rating list; TMDB recommendations of the films you love most; TMDB discover with your filters. Every LLM title is resolved against TMDB and dropped if it does not exist.
3. **Hard filters in code** (`rejectReason` in `src/core/engine/request.ts`): year, runtime, genres, language, streaming availability, watched, dismissed, already shown. Nothing reaches the feed without passing this function on a full TMDB record.
4. **LLM judge** predicts *your* rating for the best ~36 candidates, scores the fit to tonight's request and writes the explanation. It may only cite your films through tags (`[L12]`); `validateWhy` checks every tag against your library (rated ≥ 3.5★) and rejects star claims. Failed explanations fall back to a deterministic one.
5. **Blend** 60% judge + 40% taste model, adjust for request fit and the familiar ↔ obscure dial, drop predicted misses (< 3★), then pick batches so one director or near-twin does not dominate.

While you wait, the screen shows what the engine is doing, not a canned animation (`src/core/wall.ts`, `src/ui/Wait.tsx`): the wall of posters starts with your own films, every candidate found takes a tile, the finalists take over when the judge starts, tiles go dark as the judge's verdicts stream in, and the chosen films light up before the feed opens. The progress bar runs on how long each stage took in your last searches.

**Backgrounds.** Behind each poster the feed shows a scene from the film. TMDB's main "backdrop" is often poster artwork without the title (13 of 21 films checked by eye), and nothing in its data tells the two apart. So after the picks are on screen, one small vision call per batch looks at up to five textless backdrops per film and picks a real scene (`src/core/engine/scenes.ts`; about 10 s and 3,600 input tokens for 8 films at low detail, 21 of 21 real scenes in the same check). The choice is saved with the film; until it arrives, and for films without a usable image, the poster is shown as a soft glow.

No agent framework: the pipeline is a fixed sequence of two LLM calls with code-enforced constraints in between. LangChain/LangGraph would add a dependency and an orchestration layer without changing any of the steps.

### Evaluation

Goal: after watching, you rate the film ≥ 3★. `npm run eval` measures this offline on a Letterboxd export (never committed; caches live in the git-ignored `.eval_cache/`).

Ratings are held out in 5 stratified folds. The engine sees the other four and ranks the hidden films; we look at what the user really thought of the 10 films per fold it would have recommended first.

Results on one export (193 rated films, 88% of them ≥ 3★, model `gpt-6.1-sol`):

| Ranking by | AUC ≥3★ | hit@10 (≥3★) | loved@10 (≥4★) | mean rating@10 | misses in 50 |
|---|---|---|---|---|---|
| TMDB score (baseline) | 0.793 | 96% | 78% | 4.18 | 2 |
| Taste model | 0.806 | 96% | 72% | 4.09 | 2 |
| LLM judge | 0.847 | 98% | 68% | 4.01 | 1 |
| **Blend (shipped)** | **0.849** | **98%** | **80%** | **4.22** | **1** |

How stable is this? An earlier run with a different fold split gave the blend 0.864 / 100% / 84% / 0 misses and the baseline 0.790 / 96% / 76% / 2 misses, and the taste model alone scores 0.82–0.84 over three repeated splits (`eval local`). So the ordering holds, while single numbers move by about ±0.02.

Tried and rejected: running the judge at high instead of medium reasoning effort. On the same folds 165 of 193 predictions were identical, hit@10 and loved@10 did not change (blend AUC 0.857 vs 0.849), and each call took noticeably longer, so the app keeps medium (`npm run eval -- judge --effort high` repeats the comparison).

A second check runs the whole pipeline blind: a fold of ratings is hidden completely (as if those films were unseen), the engine recommends freely from all of TMDB, and we look at the hidden films it happens to bring back (2 folds, 78 hidden films):

| Hidden films… | n | ≥3★ | ≥4★ | mean rating |
|---|---|---|---|---|
| all (base rate) | 78 | 87% | 47% | 3.57 |
| proposed by LLM scouting | 6 | 100% | 83% | 4.08 |
| kept after judging | 6 | 100% | 100% | 4.33 |
| shown in the first batch | 2 | 100% | 100% | 4.75 |

This is one person and about 200 ratings, with only 23 films below 3★, so differences of a few points are within noise. Treat the numbers as a rough signal and read sample outputs as well.

```sh
npm run eval -- local  --export <export folder or zip> [--ablate]   # taste model only, no LLM
npm run eval -- signin                                              # ChatGPT sign-in for the CLI
npm run eval -- judge  --export <…> [--effort high]                 # held-out rating prediction
npm run eval -- blind  --export <…> [--prompt "…"]                  # full pipeline on hidden ratings
```

## Letterboxd

- **ZIP import:** get the file on the Letterboxd website (sign in at letterboxd.com → Settings → Data → Export your data; the Letterboxd apps have no export) and drop in the whole ZIP. The app finds `ratings.csv`, `watched.csv`, `watchlist.csv`, `diary.csv`, `reviews.csv`, `likes/films.csv`, favourite lists and `profile.csv` (username) by itself and matches every film to TMDB by title and year. Series that Letterboxd lists are not films on TMDB and stay unmatched.
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
```

Release builds, signing and the Play Store listing: [docs/play-store.md](docs/play-store.md).

## Project layout

```
src/core/        platform-neutral TypeScript, shared by the app and the eval CLI
  engine/        taste model, request + hard filters, prompts, recommender, scene picking
  auth.ts        Sign in with ChatGPT (PKCE, loopback redirect, ID-token check, rotating refresh)
  llm.ts         streaming Responses API client
  letterboxd.ts  ZIP import, TMDB matching, RSS sync
  tmdb.ts        TMDB client and film cache
  wall.ts        what the wait screen's poster wall shows, without the drawing
src/app/         device bindings and app state (secure storage, files, stores)
src/ui/          screens and components
modules/loopback-auth/   native 127.0.0.1 listener for the sign-in redirect (Kotlin, Swift)
tool/            offline evaluation, icon drawing (make-icons.sh)
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
