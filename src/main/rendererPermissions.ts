import type { Session } from 'electron';

type PermissionRequestName = Parameters<
  NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>
>[1];
type PermissionCheckName = Parameters<
  NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>
>[1];

export type RendererPermissionName = PermissionRequestName | PermissionCheckName;

export const RENDERER_ALLOWED_PERMISSIONS = [
  'clipboard-sanitized-write',
  'fullscreen',
] as const satisfies readonly RendererPermissionName[];

const RENDERER_ALLOWED_PERMISSION_SET = new Set<string>(RENDERER_ALLOWED_PERMISSIONS);

export function isRendererPermissionAllowed(permission: string): boolean {
  return RENDERER_ALLOWED_PERMISSION_SET.has(permission);
}
