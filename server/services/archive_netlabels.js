// Internet Archive Netlabels — curated CC releases from netlabels (Kahvi,
// Test Tube, Monotonik, Zeromoon, etc.). All actual fetch + dedup +
// spoken-word logic lives in archive-base.js so that archive_cylinders
// (and any future IA collection ingestion) reuses the same code.

import { createArchiveSourceFetcher } from './archive-base.js';

export const ARCHIVE_NETLABELS_QUERIES = [{ name: 'netlabels' }];

const fetcher = createArchiveSourceFetcher({
  sourceName: 'archive_netlabels',
  collection: 'netlabels',
});

export const fetchTracksPage = fetcher.fetchTracksPage;
