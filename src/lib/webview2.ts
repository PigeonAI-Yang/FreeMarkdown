/**
 * Window.chrome.webview（WebView2 专用）类型声明。
 * postMessageWithAdditionalObjects 可将 DOM File 对象传给原生层，
 * 原生经 ICoreWebView2File::Path 取真实路径（见 Rust filedrop 桥）。
 */
export interface WebView2Chrome {
  webview: {
    postMessage: (msg: unknown) => void;
    postMessageWithAdditionalObjects: (msg: unknown, objs: unknown[]) => void;
    addEventListener: (
      type: string,
      listener: (e: MessageEvent) => void,
    ) => void;
    removeEventListener: (
      type: string,
      listener: (e: MessageEvent) => void,
    ) => void;
  };
}

export function getChrome(): WebView2Chrome | null {
  const w = window as unknown as { chrome?: WebView2Chrome };
  return w.chrome ?? null;
}
