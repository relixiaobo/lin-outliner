import type { NodeId, ReferenceTarget, RichText, SearchQueryExpr } from '../types';

export interface SourceSpan {
  start: number;
  end: number;
  line?: number;
  column?: number;
}

export interface TagDraft {
  name: string;
  source?: SourceSpan;
}

export interface SearchDraft {
  view?: string;
  query?: SearchQueryExpr;
}

export interface NodeDraft {
  kind: 'content' | 'reference' | 'codeBlock' | 'search';
  content: RichText;
  description?: string | null;
  tags: TagDraft[];
  fields: FieldDraft[];
  checkbox?: boolean | null;
  referenceTarget?: ReferenceTarget;
  codeLanguage?: string;
  search?: SearchDraft;
  children: NodeDraft[];
  annotationId?: NodeId;
  source?: SourceSpan;
}

export interface FieldDraft {
  name: string;
  annotationId?: NodeId;
  values: NodeDraft[];
  clear: boolean;
  source?: SourceSpan;
}

export type InlineMetadataMode = 'none' | 'tags' | 'tags-and-fields';

export interface InlineFieldToken {
  name: string;
  value: string;
  source: SourceSpan;
}

export interface InlineScanOptions {
  metadata?: InlineMetadataMode;
  linkifyBareUrls?: boolean;
  references?: boolean;
}

export interface MarkdownInlineScanResult {
  source: string;
  content: RichText;
  tags: TagDraft[];
  fields: InlineFieldToken[];
}

export interface RichTextInlineScanResult {
  content: RichText;
  tags: TagDraft[];
  fields: InlineFieldToken[];
}
