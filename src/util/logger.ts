import * as core from '@actions/core';

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  group<T>(label: string, fn: () => Promise<T>): Promise<T>;
}

export const actionsLogger: Logger = {
  debug: (m) => core.debug(m),
  info: (m) => core.info(m),
  warn: (m) => core.warning(m),
  error: (m) => core.error(m),
  group: (label, fn) => core.group(label, fn),
};

export const consoleLogger: Logger = {
  debug: (m) => console.debug(`[debug] ${m}`),
  info: (m) => console.log(m),
  warn: (m) => console.warn(`[warn] ${m}`),
  error: (m) => console.error(`[error] ${m}`),
  group: async (label, fn) => {
    console.log(`▼ ${label}`);
    try {
      return await fn();
    } finally {
      console.log(`▲ ${label}`);
    }
  },
};
