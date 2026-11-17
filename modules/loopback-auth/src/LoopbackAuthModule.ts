import { NativeModule, requireNativeModule } from 'expo';

declare class LoopbackAuthModule extends NativeModule<{}> {
  /** Starts a listener on 127.0.0.1 and resolves with its port. */
  start(path: string, state: string, okHtml: string, failHtml: string): Promise<number>;
  /** Resolves with the query string of the callback request; rejects when stopped first. */
  wait(): Promise<string>;
  stop(): void;
}

export default requireNativeModule<LoopbackAuthModule>('LoopbackAuth');
