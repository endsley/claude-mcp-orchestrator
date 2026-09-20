import type { AppConfig } from '../config/schema.js';
import type { JsonValue } from '../types/json.js';
import type { ContextAssemblyConfiguration, ContextProviderSettings, ContextProfile } from './contracts.js';

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === 'object' && value !== null && Object.values(value).every(isJsonValue);
}

function safeOptions(raw: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(raw).flatMap(([key, value]) => isJsonValue(value) ? [[key, value]] : []));
}

/** Maps validated application configuration onto the provider-only subsystem. */
export function contextAssemblyConfiguration(config: AppConfig): ContextAssemblyConfiguration {
  const profiles: Record<string, ContextProfile> = Object.fromEntries(
    Object.entries(config.contextProfiles).map(([id, profile]) => [id, {
      providers: profile.providers,
      ...(profile.maxTokens === undefined ? {} : { maxTokens: profile.maxTokens }),
    }]),
  );
  const providers: Record<string, ContextProviderSettings> = Object.fromEntries(
    Object.entries(config.initialContext.providers).map(([id, setting]) => [id, {
      ...(setting.enabled === undefined ? {} : { enabled: setting.enabled }),
      ...(setting.priority === undefined ? {} : { priority: setting.priority }),
      ...(setting.timeoutMs === undefined ? { timeoutMs: config.initialContext.defaultTimeoutMs } : { timeoutMs: setting.timeoutMs }),
      ...(setting.cacheTtlMs === undefined ? {} : { cacheTtlMs: setting.cacheTtlMs }),
      options: safeOptions(setting.options),
    }]),
  );
  return {
    defaultProfile: config.initialContext.defaultProfile,
    maxTokens: config.initialContext.maxTokens,
    defaultTimeoutMs: config.initialContext.defaultTimeoutMs,
    retrievalConcurrency: config.initialContext.maxConcurrency,
    profiles,
    providers,
  };
}
