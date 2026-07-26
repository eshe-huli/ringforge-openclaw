import WebSocket from 'ws';
import type { OpenClawConfig } from './config.js';

type Handler = (payload: Record<string, unknown>) => void;

export class RingForgePlugin {
  private ws: WebSocket | null = null;
  private ref = 0;
  private topic = 'fleet:lobby';
  private agentId?: string;
  private fleetId?: string;
  private handlers = new Map<string, Set<Handler>>();
  private heartbeat?: ReturnType<typeof setInterval>;

  constructor(private config: OpenClawConfig) {}

  async start(): Promise<void> {
    if (!this.config.apiKey) {
      throw new Error('RingForge apiKey is required');
    }

    await this.connect();
    await this.joinFleet();
    this.heartbeat = setInterval(() => this.push('heartbeat', {}), 30_000);

    this.on('direct:message', (payload) => {
      console.log('[openclaw] DM received:', JSON.stringify(payload));
    });

    this.on('task:assigned', (payload) => {
      console.log('[openclaw] Task assigned:', JSON.stringify(payload));
    });

    console.log(`[openclaw] Connected as ${this.agentId} in fleet ${this.fleetId}`);
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close();
    this.ws = null;
  }

  on(event: string, handler: Handler): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  private connect(): Promise<void> {
    const url = this.buildUrl();
    this.ws = new WebSocket(url);

    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (!Array.isArray(msg)) return;
        const event = msg[3];
        const payload = msg[4]?.response ?? msg[4]?.payload ?? msg[4] ?? {};
        if (typeof event === 'string') {
          this.handlers.get(event)?.forEach((fn) => fn(payload));
        }
      } catch {
        // ignore malformed frames
      }
    });

    return new Promise((resolve, reject) => {
      this.ws!.once('open', () => resolve());
      this.ws!.once('error', (err) => reject(err));
    });
  }

  private buildUrl(): string {
    const base = this.config.hubUrl.replace(/\/$/, '');
    const agent = encodeURIComponent(JSON.stringify({
      name: this.config.agentName,
      capabilities: this.config.capabilities,
      framework: 'openclaw',
    }));
    return `${base}?api_key=${encodeURIComponent(this.config.apiKey)}&agent=${agent}`;
  }

  private nextRef(): string {
    this.ref += 1;
    return String(this.ref);
  }

  private push(event: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.send(this.topic, event, payload);
  }

  private send(topic: string, event: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!this.ws) return reject(new Error('not connected'));
      const ref = this.nextRef();
      const frame = JSON.stringify([ref, ref, topic, event, { payload }]);

      const onMessage = (raw: WebSocket.RawData) => {
        const msg = JSON.parse(String(raw));
        if (Array.isArray(msg) && msg[1] === ref && msg[3] === 'phx_reply') {
          this.ws?.off('message', onMessage);
          const response = msg[4]?.response ?? msg[4] ?? {};
          if (msg[4]?.status === 'error') reject(new Error(JSON.stringify(response)));
          else resolve(response);
        }
      };

      this.ws.on('message', onMessage);
      this.ws.send(frame);
    });
  }

  private async joinFleet(): Promise<void> {
    const reply = await this.send('fleet:lobby', 'phx_join', {});
    this.fleetId = String(reply.fleet_id || this.config.fleetId || 'default');
    this.agentId = String(reply.agent_id || this.config.agentName);
    if (reply.topic) this.topic = String(reply.topic);
    else this.topic = `fleet:${this.fleetId}`;

    await this.push('presence:update', { state: 'online', framework: 'openclaw' });
  }
}
