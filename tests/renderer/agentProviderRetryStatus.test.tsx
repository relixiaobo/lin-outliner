import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentProviderRetryStatus } from '../../src/renderer/ui/agent/AgentProviderRetryStatus';

describe('AgentProviderRetryStatus', () => {
  test('announces the current retry in one stable transcript-tail row', () => {
    const html = renderToStaticMarkup(
      <AgentProviderRetryStatus
        status={{
          runId: 'run-1',
          kind: 'request',
          attempt: 3,
          maxRetries: 4,
          timestamp: 100,
        }}
      />,
    );

    expect(html).toContain('class="agent-provider-retry-status"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('Reconnecting 3/4');
  });
});
