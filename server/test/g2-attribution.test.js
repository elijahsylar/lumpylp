// Item 11: attribution derivation per source, and license coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { attributionFor } from '../lib/attribution.js';
import { licenseInfo, PROD_OBSERVED_LICENSES } from '../lib/licenses.js';

const cases = [
  [{ source: 'archive_netlabels', external_id: '0-hz-immersion-into-wallbient:01.0 hz - entrance wall' }, 'https://archive.org/details/0-hz-immersion-into-wallbient', true],
  [{ source: 'archive_pd78s', external_id: '1922-USA-Archives-1922-03-31-Vincent-Lopez:1922 (usa)' }, 'https://archive.org/details/1922-USA-Archives-1922-03-31-Vincent-Lopez', true],
  [{ source: 'phlow', external_id: '1bit_001:1bit_001_-_01' }, 'https://archive.org/details/1bit_001', true],
  [{ source: 'jamendo', external_id: '168' }, 'https://www.jamendo.com/track/168', true],
  [{ source: 'audius', external_id: 'G0wyE' }, 'https://audius.co/tracks/G0wyE', true],
  [{ source: 'ccmixter', external_id: '69955', stream_url: 'https://ccmixter.org/content/texasradiofish/texasradiofish_-_Mars.mp3' }, 'https://ccmixter.org/files/texasradiofish/69955', true],
  [{ source: 'wikimedia', external_id: 'File:Ludwig van Beethoven - Op 62.ogg' }, 'https://commons.wikimedia.org/wiki/File:Ludwig_van_Beethoven_-_Op_62.ogg', true],
  [{ source: 'loc_jukebox', external_id: 'jukebox-254546' }, 'https://www.loc.gov/item/jukebox-254546/', true],
  [{ source: 'loc_jukebox', external_id: '2017655315' }, 'https://www.loc.gov/item/2017655315/', true],
  [{ source: 'musopen', external_id: '924' }, 'https://musopen.org/', false],
  [{ source: 'ucsb_cylinders', external_id: 'ucsb_cylinders:0006' }, 'https://cylinders.library.ucsb.edu/', false],
  [{ source: 'incompetech', external_id: 'USUAN2500003' }, 'https://incompetech.com/music/royalty-free/', false],
  [{ source: 'audionautix', external_id: 'music-limosine' }, 'https://audionautix.com/', false],
];

test('source_url per source (exact item page where derivable)', () => {
  for (const [t, url, exact] of cases) {
    const a = attributionFor({ artist_name: 'X', license: 'cc-by', ...t });
    assert.equal(a.source_url, url, t.source);
    assert.equal(a.source_url_exact, exact, t.source);
    assert.ok(a.source_name && !a.source_name.includes('_'), t.source);
  }
});

test('every license value seen in production maps to a known license', () => {
  const unknown = PROD_OBSERVED_LICENSES.filter((v) => !licenseInfo(v).known);
  assert.deepEqual(unknown, []);
});

test('license names and links', () => {
  assert.deepEqual(licenseInfo('by-nc-nd'), { ...licenseInfo('cc-by-nc-nd') });
  assert.equal(licenseInfo('cc-by-nc-sa').url, 'https://creativecommons.org/licenses/by-nc-sa/');
  assert.equal(licenseInfo('public-domain').name, 'Public domain (US)');
  assert.match(licenseInfo('all-rights-reserved').name, /Audius/);
  assert.equal(licenseInfo('something-new').known, false);
  assert.equal(licenseInfo('').name, 'License unknown');
});

test('a missing artist falls back to "Performer unlisted"', () => {
  assert.equal(attributionFor({ source: 'jamendo', external_id: '1', artist_name: '' }).artist, 'Performer unlisted');
});
