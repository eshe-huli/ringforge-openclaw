import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'yaml';

export interface OpenClawConfig {
  enabled: boolean;
  hubUrl: string;
  apiKey: string;
  fleetId?: string;
  agentName: string;
  capabilities: string[];
}

export async function loadConfig(): Promise<OpenClawConfig> {
  const configPath = process.env.OPENCLAW_CONFIG || path.join(process.cwd(), 'openclaw.yaml');
  let fileConfig: Record<string, unknown> = {};

  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = yaml.parse(raw) as { ringforge?: Record<string, unknown> };
    fileConfig = parsed.ringforge || {};
  } catch {
    // fall back to env-only config
  }

  const enabled = envBool('RINGFORGE_ENABLED', fileConfig.enabled, true);
  const hubUrl = process.env.RINGFORGE_HUB_URL || String(fileConfig.hubUrl || fileConfig.server || 'wss://hub.ringforge.dev/ws/websocket');
  const apiKey = process.env.RINGFORGE_API_KEY || String(fileConfig.apiKey || fileConfig.api_key || '');
  const agentName = process.env.RINGFORGE_AGENT_NAME || String(fileConfig.agentName || fileConfig.agent_name || 'openclaw-agent');
  const fleetId = process.env.RINGFORGE_FLEET_ID || (fileConfig.fleetId ? String(fileConfig.fleetId) : undefined);
  const capabilities = parseCapabilities(process.env.RINGFORGE_CAPABILITIES || fileConfig.capabilities);

  return { enabled, hubUrl, apiKey, fleetId, agentName, capabilities };
}

function envBool(name: string, fileValue: unknown, defaultValue: boolean): boolean {
  if (process.env[name] != null) return process.env[name] === 'true';
  if (typeof fileValue === 'boolean') return fileValue;
  if (fileValue == null) return defaultValue;
  return Boolean(fileValue);
}

function parseCapabilities(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
  return ['code', 'research'];
}
