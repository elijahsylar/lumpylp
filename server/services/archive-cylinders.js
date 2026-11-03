// Cylinder recordings via Internet Archive. The originally-spec'd
// `UCSBCylinder` collection doesn't exist on IA (the UCSB Cylinder Audio
// Archive lives at https://cylinders.library.ucsb.edu and was never
// mirrored to IA under that name). The closest match is `cylindertransfer`
// — a 183-item mirror of cylinder.de's archive — all pre-1923 PD content.
// To grow this source we'd need to scrape the UCSB site directly or pull
// from the much-larger `78rpm` collection (309k items, mixed format).

import { createArchiveSourceFetcher } from './archive-base.js';

export const ARCHIVE_CYLINDERS_QUERIES = [{ name: 'cylindertransfer' }];

const fetcher = createArchiveSourceFetcher({
  sourceName: 'archive_cylinders',
  collection: 'cylindertransfer',
});

export const fetchTracksPage = fetcher.fetchTracksPage;
