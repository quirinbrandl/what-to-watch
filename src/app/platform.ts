// Bindings between the platform-neutral core and the device.
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import * as Haptics from 'expo-haptics';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import LoopbackAuth from '../../modules/loopback-auth/src/LoopbackAuthModule';
import { AuthPlatform, Loopback, SecretStore, authDebug } from '../core/auth';

if (__DEV__) authDebug.log = (stage, message) => console.warn(`auth ${stage}:`, message);

/** Android Keystore / iOS Keychain. */
export const secrets: SecretStore = {
  async read(key) {
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },
  async write(key, value) {
    if (value === null) await SecureStore.deleteItemAsync(key);
    else await SecureStore.setItemAsync(key, value);
  },
};

const loopback: Loopback = {
  start: (o) => LoopbackAuth.start(o.path, o.state, o.okHtml, o.failHtml),
  wait: () => LoopbackAuth.wait(),
  stop: () => LoopbackAuth.stop(),
};

/**
 * The app link the sign-in "done" page jumps to, which brings the app back.
 * The scheme is the application id, so no other app can claim it.
 */
export const AUTH_RETURN_URL = 'dev.whattowatch.app://auth';

export const authPlatform: AuthPlatform = {
  store: secrets,
  loopback,
  randomBytes: (n) => Crypto.getRandomBytes(n),
  async openBrowser(url) {
    if (Platform.OS === 'ios') {
      // ASWebAuthenticationSession: resolves when the sheet is gone.
      await WebBrowser.openAuthSessionAsync(url, AUTH_RETURN_URL);
      return 'closed';
    }
    // Android: a Custom Tab. The app notices the return itself (see AppState.signIn).
    await WebBrowser.openBrowserAsync(url, { showInRecents: false });
    return 'opened';
  },
};

// ---------------------------------------------------------------- JSON files

const dataDir = new Directory(Paths.document, 'data');

/**
 * JSON documents in the app's private storage, written atomically (temp file
 * + move) so a crash mid-write cannot corrupt user data.
 */
export const files = {
  async read(name: string): Promise<any | undefined> {
    for (const f of [new File(dataDir, `${name}.json`), new File(dataDir, `${name}.json.tmp`)]) {
      try {
        if (f.exists) return JSON.parse(await f.text());
      } catch {}
    }
    return undefined;
  },
  async write(name: string, data: unknown): Promise<void> {
    dataDir.create({ intermediates: true, idempotent: true });
    const tmp = new File(dataDir, `${name}.json.tmp`);
    tmp.create({ overwrite: true });
    await tmp.write(JSON.stringify(data));
    const dest = new File(dataDir, `${name}.json`);
    if (dest.exists) dest.delete();
    await tmp.move(dest);
  },
  remove(name: string): void {
    for (const f of [new File(dataDir, `${name}.json`), new File(dataDir, `${name}.json.tmp`)]) {
      try {
        if (f.exists) f.delete();
      } catch {}
    }
  },
  /** Writes a file the user can share (backup export) and returns its URI. */
  async temp(name: string, text: string): Promise<string> {
    const f = new File(Paths.cache, name);
    f.create({ overwrite: true });
    await f.write(text);
    return f.uri;
  },
  bytes: (uri: string): Promise<Uint8Array> => new File(uri).bytes(),
  text: (uri: string): Promise<string> => new File(uri).text(),
};

export const tick = () => void Haptics.selectionAsync().catch(() => {});
export const thud = () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
