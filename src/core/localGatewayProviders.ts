export const CC_SWITCH_LOCAL_PROVIDER_ID = 'cc-switch';
export const CC_SWITCH_LOCAL_PROVIDER_NAME = 'CC Switch';
export const CC_SWITCH_LOCAL_BASE_URL = 'http://127.0.0.1:15721/v1';
export const CC_SWITCH_LOCAL_HEALTH_URL = 'http://127.0.0.1:15721/health';
export const CC_SWITCH_LOCAL_DEFAULT_MODEL_ID = 'gpt-5.4';

export function isLocalGatewayProviderId(providerId: string): boolean {
  return providerId === CC_SWITCH_LOCAL_PROVIDER_ID;
}
