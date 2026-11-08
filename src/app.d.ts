declare global {
  namespace App {}

  // File Handling API (desktop Chromium "Open with" for installed PWAs).
  interface LaunchParams {
    readonly targetURL?: string;
    readonly files: readonly FileSystemHandle[];
  }

  interface LaunchQueue {
    setConsumer(consumer: (params: LaunchParams) => void): void;
  }

  interface Window {
    readonly launchQueue?: LaunchQueue;
  }
}

export {};
