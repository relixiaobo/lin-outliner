export interface ScheduledMaterial {
  readonly kind: 'file' | 'note' | 'url';
  readonly reference: string;
  readonly required: boolean;
}
export function decodeScheduledMaterials(value: unknown): readonly ScheduledMaterial[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error('Materials must contain at most 32 references');
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid material');
    const row = entry as Record<string, unknown>;
    if (Object.keys(row).some((key) => !['kind', 'reference', 'required'].includes(key))) throw new Error('Unknown material field');
    if (row.kind !== 'file' && row.kind !== 'note' && row.kind !== 'url') throw new Error('Material must be a file, note, or URL');
    if (typeof row.reference !== 'string' || !row.reference.trim() || row.reference.length > 4096 || row.reference.includes('\0')) throw new Error('Invalid material reference');
    if (row.required !== undefined && typeof row.required !== 'boolean') throw new Error('Material required must be a boolean');
    // Whitespace is part of a filesystem identity; trimming could select a
    // different existing file after a native picker returned the exact path.
    const reference = row.kind === 'file' ? row.reference : row.reference.trim();
    if (row.kind === 'file' && !reference.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(reference)) throw new Error('File material must use an absolute path');
    if (row.kind === 'url' && !['http:', 'https:'].includes(new URL(reference).protocol)) throw new Error('URL material must use HTTP or HTTPS');
    return { kind: row.kind, reference, required: row.required !== false };
  });
}
