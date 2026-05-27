import type { CSSProperties } from 'react';
import type { NodeProjection } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { projectTagConfig, type ConfigNodeMap } from '../../../core/configProjection';

export interface TagColor {
  text: string;
  background: string;
}

const TAG_COLORS: TagColor[] = [
  { text: '#e11d48', background: '#fff1f2' },
  { text: '#ea580c', background: '#fff7ed' },
  { text: '#ca8a04', background: '#fefce8' },
  { text: '#059669', background: '#ecfdf5' },
  { text: '#2563eb', background: '#eff6ff' },
  { text: '#9333ea', background: '#faf5ff' },
  { text: '#db2777', background: '#fdf2f8' },
  { text: '#475569', background: '#f8fafc' },
];

const TAG_COLOR_GRAY: TagColor = { text: '#475569', background: '#f8fafc' };

const TAG_COLOR_MAP: Record<string, TagColor> = {
  red: TAG_COLORS[0],
  orange: TAG_COLORS[1],
  amber: TAG_COLORS[2],
  yellow: TAG_COLORS[2],
  green: TAG_COLORS[3],
  emerald: TAG_COLORS[3],
  teal: TAG_COLORS[3],
  sky: TAG_COLORS[4],
  blue: TAG_COLORS[4],
  indigo: TAG_COLORS[5],
  violet: TAG_COLORS[5],
  purple: TAG_COLORS[5],
  rose: TAG_COLORS[6],
  pink: TAG_COLORS[6],
  brown: TAG_COLOR_GRAY,
  slate: TAG_COLOR_GRAY,
  gray: TAG_COLOR_GRAY,
};

export interface TagColorPreset {
  /** Canonical token persisted on the tag's `color` config. */
  token: string;
  label: string;
  color: TagColor;
}

/**
 * The pickable supertag colors, in display order. One canonical token per base
 * color in TAG_COLORS; resolveTagColor maps the token back through
 * TAG_COLOR_MAP, so storage stays token-based (theme-aware) rather than raw hex.
 */
export const TAG_COLOR_PRESETS: readonly TagColorPreset[] = [
  { token: 'red', label: 'Red', color: TAG_COLORS[0] },
  { token: 'orange', label: 'Orange', color: TAG_COLORS[1] },
  { token: 'amber', label: 'Amber', color: TAG_COLORS[2] },
  { token: 'green', label: 'Green', color: TAG_COLORS[3] },
  { token: 'blue', label: 'Blue', color: TAG_COLORS[4] },
  { token: 'purple', label: 'Purple', color: TAG_COLORS[5] },
  { token: 'pink', label: 'Pink', color: TAG_COLORS[6] },
  { token: 'gray', label: 'Gray', color: TAG_COLOR_GRAY },
];

const JOURNAL_TAG_IDS = new Set(['tag:day', 'tag:week', 'tag:year']);

function hashTagColor(tagId: string): TagColor {
  let hash = 0;
  for (let index = 0; index < tagId.length; index += 1) {
    hash = Math.imul(hash ^ tagId.charCodeAt(index), 0x5bd1e995);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return TAG_COLORS[(hash >>> 0) % TAG_COLORS.length];
}

export function resolveTagColor(tag: NodeProjection | undefined, byId: ConfigNodeMap): TagColor {
  if (!tag) return TAG_COLOR_GRAY;
  if (JOURNAL_TAG_IDS.has(tag.id)) return TAG_COLOR_GRAY;
  // config-as-nodes: the tag's color token lives in its defConfig subtree.
  const color = projectTagConfig(byId, tag).color;
  if (color) {
    if (color.startsWith('#')) {
      // Legacy raw-hex tags (preset picker now stores tokens). Mix toward the
      // surface token rather than literal white so the tint follows the theme.
      return {
        text: color,
        background: `color-mix(in srgb, ${color} 10%, var(--surface))`,
      };
    }
    const mapped = TAG_COLOR_MAP[color];
    if (mapped) return mapped;
  }
  return hashTagColor(tag.id);
}

export function tagBulletColors(tags: readonly NodeProjection[], byId: ConfigNodeMap): string[] {
  return tags.map((tag) => resolveTagColor(tag, byId).text);
}

export function conicColorStyle(colors: readonly string[]): CSSProperties | undefined {
  if (colors.length === 0) return undefined;
  if (colors.length === 1) return { background: colors[0] };
  const segment = 100 / colors.length;
  const stops = colors
    .map((color, index) => `${color} ${index * segment}% ${(index + 1) * segment}%`)
    .join(', ');
  return { background: `conic-gradient(${stops})` };
}

export function inlineReferenceTextColor(
  targetNodeId: string,
  index: DocumentIndex,
): string | undefined {
  const target = index.byId.get(targetNodeId);
  const firstTagId = target?.tags[0];
  if (!firstTagId) return undefined;
  return resolveTagColor(index.byId.get(firstTagId), index.byId).text;
}
