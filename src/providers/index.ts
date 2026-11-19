import type { Provider, ProviderId } from '../types.ts';
import { chatgptProvider } from './chatgpt.ts';
import { claudeProvider } from './claude.ts';

export const providers: Partial<Record<ProviderId, Provider<unknown>>> = {
  claude: claudeProvider as Provider<unknown>,
  chatgpt: chatgptProvider as Provider<unknown>,
};
