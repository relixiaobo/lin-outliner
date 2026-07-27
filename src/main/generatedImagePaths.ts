import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  AGENT_GENERATED_IMAGE_DIR,
  isPathInside,
} from './agent/capabilities/agentAttachmentMaterialization';

export interface GeneratedImageReadWorkspace {
  scratchRoot: string;
}

export async function resolveGeneratedImageReadPath(
  workspace: GeneratedImageReadWorkspace,
  inputPath: string,
): Promise<string | null> {
  if (path.isAbsolute(inputPath)) return null;
  const normalized = path.normalize(inputPath.trim());
  const isGeneratedImageReference = normalized === AGENT_GENERATED_IMAGE_DIR
    || normalized.startsWith(`${AGENT_GENERATED_IMAGE_DIR}${path.sep}`);
  if (!isGeneratedImageReference) return null;

  const generatedRoot = path.join(path.resolve(workspace.scratchRoot), AGENT_GENERATED_IMAGE_DIR);
  const candidate = path.join(path.resolve(workspace.scratchRoot), normalized);
  try {
    const [generatedRootRealPath, candidateRealPath] = await Promise.all([
      realpath(generatedRoot),
      realpath(candidate),
    ]);
    if (!isPathInside(generatedRootRealPath, candidateRealPath)) {
      throw new Error('Generated image path escapes the generated-image directory.');
    }
    const candidateStat = await stat(candidateRealPath);
    if (!candidateStat.isFile()) {
      throw new Error('Generated image path is not a file.');
    }
    return candidateRealPath;
  } catch (error) {
    throw new Error(`Generated image path is not readable: ${inputPath}`, { cause: error });
  }
}
