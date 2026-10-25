export {};

declare global {
  var chrome: ChromeGlobal;
  var __PN_CANDIDATE_ID__: string | undefined;

  interface Navigator {
    deviceMemory?: number;
    gpu?: object;
  }

  interface Error {
    code?: string;
  }

  interface ChromeEvent<Listener extends (...args: unknown[]) => unknown = (...args: unknown[]) => unknown> {
    addListener(listener: Listener): void;
    removeListener?(listener: Listener): void;
    hasListener?(listener: Listener): boolean;
  }

  interface ChromeStorageArea {
    get?: Function;
    set?: Function;
    remove?: Function;
    clear?: Function;
  }

  interface ChromeGlobal {
    runtime: {
      id?: string;
      getURL(path: string): string;
      sendMessage(message: unknown): Promise<unknown>;
      onMessage: ChromeEvent<(message: Record<string, unknown>, sender: Record<string, unknown>, sendResponse: (response?: unknown) => void) => boolean | void>;
      onInstalled?: ChromeEvent<(details: { reason?: string }) => void>;
    };
    storage: {
      local: ChromeStorageArea;
      onChanged: ChromeEvent<(changes: Record<string, { newValue?: unknown; oldValue?: unknown }>, areaName: string) => void>;
    };
    tabs: {
      query?(queryInfo: Record<string, unknown>): Promise<Array<{ id?: number; url?: string; pendingUrl?: string; title?: string }>>;
      get?(tabId: number): Promise<Record<string, unknown>>;
      create?(createProperties: Record<string, unknown>): Promise<Record<string, unknown>>;
      update?(tabId: number, updateProperties: Record<string, unknown>): Promise<Record<string, unknown>>;
      sendMessage?(tabId: number, message: unknown): Promise<unknown>;
      onActivated: ChromeEvent<() => void>;
      onUpdated: ChromeEvent<(tabId: number, changeInfo: { status?: string; url?: string }, tab: { active?: boolean }) => void>;
      onRemoved: ChromeEvent<(tabId: number) => void>;
    };
    scripting?: {
      executeScript?(details: Record<string, unknown>): Promise<unknown[]>;
    };
    permissions?: {
      request?(permissions: Record<string, unknown>): Promise<boolean>;
      remove?(permissions: Record<string, unknown>): Promise<boolean>;
    };
    windows?: {
      getCurrent?(): Promise<Record<string, unknown>>;
    };
    commands?: {
      onCommand?: ChromeEvent<(command: string, tab?: unknown) => void>;
    };
    i18n?: {
      getMessage?(messageName: string, substitutions?: string | string[]): string;
      detectLanguage?(text: string): Promise<{ languages?: Array<{ language?: string, percentage?: number }> }>;
    };
  }
}
