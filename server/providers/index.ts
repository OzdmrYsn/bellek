import type { ModelConfig, ProviderInfo } from '../../shared/types.ts';
import { assertBudget, logUsage, type Resolved } from '../settings.ts';
import { createAnthropic } from './anthropic.ts';
import { createFal } from './fal.ts';
import { createGoogle } from './google.ts';
import { createMock } from './mock.ts';
import { createOpenAI } from './openai.ts';
import { ProviderError, type Adapter, type TextRequest, type TextResult } from './types.ts';

export function createAdapter(provider: ProviderInfo, apiKey: string): Adapter {
  switch (provider.kind) {
    case 'anthropic':
      return createAnthropic(provider, apiKey);
    case 'openai':
    case 'openai-compatible':
      return createOpenAI(provider, apiKey);
    case 'google':
      return createGoogle(provider, apiKey);
    case 'fal':
      return createFal(provider, apiKey);
    case 'mock':
      return createMock(provider, apiKey);
  }
}

export function adapterFor(resolved: Resolved): Adapter {
  return createAdapter(resolved.provider, resolved.apiKey);
}

/** Metin üretir ve kullanım günlüğüne yazar. */
export async function generateText(resolved: Resolved, request: Omit<TextRequest, 'model'>): Promise<TextResult> {
  const adapter = adapterFor(resolved);
  if (!adapter.text) throw new ProviderError(`${resolved.provider.name} metin üretimini desteklemiyor.`);
  assertBudget();
  const result = await adapter.text({ ...request, model: resolved.model });
  logUsage({
    provider: resolved.provider.id,
    model: resolved.model.id,
    kind: 'text',
    inputTokens: result.usage.input,
    outputTokens: result.usage.output,
  });
  return result;
}

/** Video modeli referans görselleri doğrudan alabiliyor mu, yoksa önce anahtar kare mi gerekir. */
export function videoAcceptsRefs(provider: ProviderInfo, model: ModelConfig): boolean {
  if (provider.kind === 'fal') return !!model.options?.refEndpoint;
  return (model.maxRefs ?? 0) > 1;
}

export function videoAcceptsStart(provider: ProviderInfo, model: ModelConfig): boolean {
  if (provider.kind === 'fal') return !!model.options?.imageEndpoint || /image-to-video/.test(model.id);
  return (model.maxRefs ?? 0) >= 1;
}
