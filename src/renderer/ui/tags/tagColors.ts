import type { CSSProperties } from 'react';
import type { NodeProjection } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { projectTagConfig, type ConfigNodeMap } from '../../../core/configProjection';
import { TAG_COLOR_TOKENS, type TagColorToken } from '../../../core/configSchema';

export interface TagColor {
  text: string;
  background: string;
}

// Tag chips must follow the theme. The accent is a fixed hue, but the chip's
// background is mixed toward the LIVE --surface token (resolved per element) so the
// same tag reads as a soft light tint in light mode and a soft dark tint in dark
// mode — never the baked near-white box that glared against a dark panel. The
// accent stays the text colour (legible on both the light and dark tint).
const TAG_SURFACE_TINT = '12%';

function accentTagColor(accent: string): TagColor {
  return {
    text: accent,
    background: `color-mix(in srgb, ${accent} ${TAG_SURFACE_TINT}, var(--surface))`,
  };
}

const TAG_COLORS: TagColor[] = [
  'var(--identity-tint-0)', // red
  'var(--identity-tint-1)', // orange
  'var(--identity-tint-2)', // amber
  'var(--identity-tint-3)', // green
  'var(--identity-tint-5)', // blue
  'var(--identity-tint-6)', // purple
  'var(--identity-tint-7)', // pink
].map(accentTagColor);

// The neutral tag can't tint an accent: baked slate vanishes on a dark
// surface. It uses theme tokens directly, matching the default .tag-badge neutral.
const TAG_COLOR_GRAY: TagColor = {
  text: 'var(--text-secondary)',
  background: 'var(--fill-3)',
};

const TAG_COLOR_MAP: Record<TagColorToken, TagColor> = {
  red: TAG_COLORS[0],
  orange: TAG_COLORS[1],
  amber: TAG_COLORS[2],
  green: TAG_COLORS[3],
  blue: TAG_COLORS[4],
  purple: TAG_COLORS[5],
  pink: TAG_COLORS[6],
  gray: TAG_COLOR_GRAY,
};

export interface TagColorPreset {
  /** Canonical token persisted on the tag's `color` config. */
  token: TagColorToken;
  label: string;
  color: TagColor;
}

/**
 * The pickable supertag colors, in display order. One canonical token per base
 * color in TAG_COLORS; resolveTagColor maps the token back through
 * TAG_COLOR_MAP, so storage stays token-based (theme-aware) rather than raw hex.
 */
const TAG_COLOR_LABELS: Record<TagColorToken, string> = {
  red: 'Red',
  orange: 'Orange',
  amber: 'Amber',
  green: 'Green',
  blue: 'Blue',
  purple: 'Purple',
  pink: 'Pink',
  gray: 'Gray',
};

export const TAG_COLOR_PRESETS: readonly TagColorPreset[] = TAG_COLOR_TOKENS.map((token) => ({
  token,
  label: TAG_COLOR_LABELS[token],
  color: TAG_COLOR_MAP[token],
}));

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
    const mapped = TAG_COLOR_MAP[color as TagColorToken];
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
