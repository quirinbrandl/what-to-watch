import { Film } from '../core/models';

import { discover } from './discover';
import { Observable, app } from './store';

export interface Choice {
  key: string;
  label: string;
  sub?: string;
}

export type Dialog =
  | { kind: 'confirm'; title: string; body: string; action: string; danger?: boolean; cancel?: string; quiet?: boolean; resolve: (ok: boolean) => void }
  | { kind: 'ask'; title: string; hint?: string; initial?: string; secret?: boolean; action: string; resolve: (v: string | undefined) => void }
  | { kind: 'info'; title: string; body: string; resolve: () => void }
  | { kind: 'choose'; title: string; items: Choice[]; current?: string; resolve: (key: string | undefined) => void };

/**
 * What is on screen above the tabs: full-screen overlays, sheets, dialogs
 * and the toast. A tiny navigator, so the Android back button and screen
 * readers always act on the topmost layer.
 */
export class Ui extends Observable {
  tab: 'discover' | 'library' | 'searches' | 'settings' = 'discover';
  feed = false;
  search = false;
  filters = false;
  film?: { film: Film; moreLike: boolean };
  dialog?: Dialog;
  toastText?: string;
  private toastTimer?: ReturnType<typeof setTimeout>;

  setTab(t: Ui['tab']): void {
    this.tab = t;
    this.notify();
  }

  openFeed(opts: { start?: boolean; seed?: Film } = {}): void {
    if (opts.start || opts.seed) void discover.start(opts.seed);
    this.film = undefined;
    this.search = false;
    this.feed = true;
    this.notify();
  }

  closeFeed(): void {
    if (discover.running && !discover.session) discover.cancel();
    this.feed = false;
    this.notify();
  }

  openSearch(open = true): void {
    this.search = open;
    this.notify();
  }

  /** Shows a saved search in the feed; closing the feed goes back to the list. */
  openSaved(id: string): void {
    discover.open(id);
    this.film = undefined;
    this.feed = true;
    this.notify();
  }

  openFilters(open = true): void {
    this.filters = open;
    this.notify();
  }

  openFilm(film: Film | undefined, moreLike = true): void {
    this.film = film ? { film, moreLike } : undefined;
    this.notify();
  }

  toast(text: string): void {
    this.toastText = text;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastText = undefined;
      this.notify();
    }, 3200);
    this.notify();
  }

  private show<T>(make: (resolve: (v: T) => void) => Dialog): Promise<T> {
    return new Promise<T>((resolve) => {
      this.dialog = make((v) => {
        this.dialog = undefined;
        this.notify();
        resolve(v);
      });
      this.notify();
    });
  }

  /** `cancel` renames the way out; `quiet` makes it the highlighted choice, for actions the app would rather you did not take. */
  confirm = (title: string, body: string, action: string, danger = false, o: { cancel?: string; quiet?: boolean } = {}) =>
    this.show<boolean>((resolve) => ({ kind: 'confirm', title, body, action, danger, ...o, resolve }));
  ask = (title: string, o: { hint?: string; initial?: string; secret?: boolean; action?: string } = {}) =>
    this.show<string | undefined>((resolve) => ({ kind: 'ask', title, action: 'Save', ...o, resolve }));
  info = (title: string, body: string) => this.show<void>((resolve) => ({ kind: 'info', title, body, resolve }));
  choose = (title: string, items: Choice[], current?: string) => this.show<string | undefined>((resolve) => ({ kind: 'choose', title, items, current, resolve }));

  /** Android back: close the topmost layer. Returns false when nothing was open. */
  back(): boolean {
    const d = this.dialog;
    if (d) {
      if (d.kind === 'confirm') d.resolve(false);
      else if (d.kind === 'info') d.resolve();
      else d.resolve(undefined);
      return true;
    }
    if (this.film) return this.openFilm(undefined), true;
    if (this.filters) return this.openFilters(false), true;
    if (this.search) return this.openSearch(false), true;
    if (this.feed) return this.closeFeed(), true;
    if (this.tab !== 'discover') return this.setTab('discover'), true;
    return false;
  }
}

export const ui = new Ui();

// ---------------------------------------------------------------- shared flows

/**
 * Shown once, the first time ChatGPT plan usage is enabled, when that happens
 * outside onboarding (onboarding has its own welcome screen).
 */
export async function showPlanWelcome(): Promise<void> {
  if (app.settings.welcomeSeen || app.settings.useApiKey) return;
  app.settings.welcomeSeen = true;
  app.changed();
  await ui.info("You're in!", 'WhatToWatch uses your ChatGPT plan to find your films. You can check your usage anytime in your ChatGPT settings.');
}

export async function signInFlow(welcome = true): Promise<boolean> {
  try {
    await app.signIn();
    if (welcome) await showPlanWelcome();
    return true;
  } catch (e) {
    // Error codes only; never tokens or URLs.
    if (__DEV__) console.warn('sign-in failed:', (e as { code?: string })?.code ?? String(e));
    ui.toast(e instanceof Error && e.message ? e.message : 'Sign-in failed.');
    return false;
  }
}

export async function apiKeyFlow(): Promise<boolean> {
  const key = (await ui.ask('OpenAI API key', { hint: 'sk-…', secret: true, action: 'Use key' }))?.trim();
  if (!key) return false;
  try {
    await app.setApiKey(key);
    ui.toast('API key saved on this device');
    return true;
  } catch {
    ui.toast('That key was not accepted');
    return false;
  }
}
