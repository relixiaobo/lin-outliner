import { previewTargetKey, type PreviewTarget } from '../../../core/preview';
import {
  localStorageOrNull,
  pruneLocalStorageEntries,
  readLocalStorageKeyedStore,
  writeLocalStorageKeyedStore,
} from '../../state/localStorageStore';

const READING_POSITION_STORE_VERSION = 1;
const READING_POSITION_MAX_ENTRIES = 100;
const PDF_READING_POSITION_STORAGE_KEY = 'lin-outliner:pdf-reading-position:v1';
const EPUB_READING_POSITION_STORAGE_KEY = 'lin-outliner:epub-reading-position:v1';

export interface PdfReadingPosition {
  pageNumber: number;
  pageOffsetRatio: number;
  updatedAt: number;
}

export interface EpubReadingPosition {
  sectionIndex: number;
  sectionOffsetRatio: number;
  updatedAt: number;
}

let pdfReadingPositionsCache: Record<string, PdfReadingPosition> | null = null;
let epubReadingPositionsCache: Record<string, EpubReadingPosition> | null = null;

export function previewReadingPositionKey(target: PreviewTarget): string {
  return previewTargetKey(target);
}

export function readPdfReadingPosition(targetKey: string): PdfReadingPosition | null {
  return readPdfReadingPositions()[targetKey] ?? null;
}

export function writePdfReadingPosition(targetKey: string, position: PdfReadingPosition): void {
  const storage = localStorageOrNull();
  if (!storage) return;
  const positions = readPdfReadingPositions();
  positions[targetKey] = position;
  pruneLocalStorageEntries(positions, READING_POSITION_MAX_ENTRIES, (entry) => entry.updatedAt);
  writeLocalStorageKeyedStore({
    storage,
    storageKey: PDF_READING_POSITION_STORAGE_KEY,
    version: READING_POSITION_STORE_VERSION,
    entriesKey: 'positions',
    entries: positions,
  });
}

export function readEpubReadingPosition(targetKey: string): EpubReadingPosition | null {
  return readEpubReadingPositions()[targetKey] ?? null;
}

export function writeEpubReadingPosition(targetKey: string, position: EpubReadingPosition): void {
  const storage = localStorageOrNull();
  if (!storage) return;
  const positions = readEpubReadingPositions();
  positions[targetKey] = position;
  pruneLocalStorageEntries(positions, READING_POSITION_MAX_ENTRIES, (entry) => entry.updatedAt);
  writeLocalStorageKeyedStore({
    storage,
    storageKey: EPUB_READING_POSITION_STORAGE_KEY,
    version: READING_POSITION_STORE_VERSION,
    entriesKey: 'positions',
    entries: positions,
  });
}

function readPdfReadingPositions(): Record<string, PdfReadingPosition> {
  if (pdfReadingPositionsCache) return pdfReadingPositionsCache;
  const storage = localStorageOrNull();
  if (!storage) {
    pdfReadingPositionsCache = {};
    return pdfReadingPositionsCache;
  }
  pdfReadingPositionsCache = readLocalStorageKeyedStore({
    storage,
    storageKey: PDF_READING_POSITION_STORAGE_KEY,
    version: READING_POSITION_STORE_VERSION,
    entriesKey: 'positions',
    decodeEntry: sanitizePdfReadingPosition,
  });
  return pdfReadingPositionsCache;
}

function readEpubReadingPositions(): Record<string, EpubReadingPosition> {
  if (epubReadingPositionsCache) return epubReadingPositionsCache;
  const storage = localStorageOrNull();
  if (!storage) {
    epubReadingPositionsCache = {};
    return epubReadingPositionsCache;
  }
  epubReadingPositionsCache = readLocalStorageKeyedStore({
    storage,
    storageKey: EPUB_READING_POSITION_STORAGE_KEY,
    version: READING_POSITION_STORE_VERSION,
    entriesKey: 'positions',
    decodeEntry: sanitizeEpubReadingPosition,
  });
  return epubReadingPositionsCache;
}

function sanitizePdfReadingPosition(value: unknown): PdfReadingPosition | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const pageNumber = record.pageNumber;
  const pageOffsetRatio = record.pageOffsetRatio;
  const updatedAt = record.updatedAt;
  if (
    typeof pageNumber !== 'number'
    || !Number.isFinite(pageNumber)
    || pageNumber < 1
    || typeof pageOffsetRatio !== 'number'
    || !Number.isFinite(pageOffsetRatio)
    || typeof updatedAt !== 'number'
    || !Number.isFinite(updatedAt)
  ) {
    return null;
  }
  return {
    pageNumber: Math.floor(pageNumber),
    pageOffsetRatio: Math.max(0, Math.min(1, pageOffsetRatio)),
    updatedAt,
  };
}

function sanitizeEpubReadingPosition(value: unknown): EpubReadingPosition | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const sectionIndex = record.sectionIndex;
  const sectionOffsetRatio = record.sectionOffsetRatio;
  const updatedAt = record.updatedAt;
  if (
    typeof sectionIndex !== 'number'
    || !Number.isFinite(sectionIndex)
    || sectionIndex < 0
    || typeof sectionOffsetRatio !== 'number'
    || !Number.isFinite(sectionOffsetRatio)
    || typeof updatedAt !== 'number'
    || !Number.isFinite(updatedAt)
  ) {
    return null;
  }
  return {
    sectionIndex: Math.floor(sectionIndex),
    sectionOffsetRatio: Math.max(0, Math.min(1, sectionOffsetRatio)),
    updatedAt,
  };
}
