import { parentPort } from 'node:worker_threads';
import {
  scanSecretStrings,
  type SecretStringScanJob,
} from './agentSecretStringScanner';

interface SecretScanWorkerRequest {
  readonly id: number;
  readonly jobs: readonly SecretStringScanJob[];
}

interface SecretScanWorkerResponse {
  readonly id: number;
  readonly outputs?: readonly string[];
  readonly error?: string;
}

const port = parentPort;
if (!port) throw new Error('Secret redaction worker requires a parent port.');

port.on('message', (request: SecretScanWorkerRequest) => {
  let response: SecretScanWorkerResponse;
  try {
    response = { id: request.id, outputs: scanSecretStrings(request.jobs) };
  } catch {
    response = { id: request.id, error: 'Secret scanner worker failed.' };
  }
  port.postMessage(response);
});
