// Separate Host lifetime: multi-folder storage/routes do not patch the native workspace service.
import { registerWorkspaces } from './workspaces.js';
export const name = 'harness-qol-workspaces';
export const inject = ['workspaceRegistry', 'storageDomain', 'systemPrompt', 'webServer', 'connection', 'tools'];
export async function apply(ctx) {
  await registerWorkspaces(ctx);
}
