import { orchestratorError } from '../types/errors.js';
import type { InitialContextProvider } from './contracts.js';

/** Registry is the only place the assembler discovers providers. */
export class ContextProviderRegistry {
  private readonly providers = new Map<string, InitialContextProvider>();

  register(provider: InitialContextProvider): void {
    if (!provider.id.trim()) {
      throw orchestratorError('INVALID_CONFIG', 'Context provider id cannot be empty.');
    }
    if (this.providers.has(provider.id)) {
      throw orchestratorError('INVALID_CONFIG', `Context provider '${provider.id}' is registered twice.`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): InitialContextProvider | undefined {
    return this.providers.get(id);
  }

  list(): InitialContextProvider[] {
    return [...this.providers.values()];
  }
}
