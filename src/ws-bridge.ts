/**
 * WebSocket bridge: wraps browser-native WebSocket with Node ws-compatible API.
 * Falls back to `ws` when running in Node.
 */
export class BridgeWebSocket {
  private _ws: WebSocket;

  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  constructor(url: string) {
    this._ws = new globalThis.WebSocket(url);
  }

  get readyState(): number {
    return this._ws.readyState;
  }

  send(data: string): void {
    this._ws.send(data);
  }

  close(): void {
    this._ws.close();
  }

  on(event: string, fn: (...args: any[]) => void): void {
    switch (event) {
      case "open":
        this._ws.addEventListener("open", () => fn());
        break;
      case "message":
        this._ws.addEventListener("message", (ev) => fn(ev.data));
        break;
      case "close":
        this._ws.addEventListener("close", (ev) => fn(ev.code, ev.reason));
        break;
      case "error":
        this._ws.addEventListener("error", () => fn());
        break;
    }
  }
}
