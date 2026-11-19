import type { Provider, ProviderId } from '../types.ts';
import { chatgptProvider } from './chatgpt.ts';
import { claudeProvider } from './claude.ts';
import { grokProvider } from './grok.ts';

export const providers: Partial<Record<ProviderId, Provider<unknown>>> = {
  claude: claudeProvider as Provider<unknown>,
  chatgpt: chatgptProvider as Provider<unknown>,
  grok: grokProvider as Provider<unknown>,
};
