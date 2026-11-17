// The quality gate maps a raw license to public-domain only when the whole
// value is a known public-domain spelling, never because the words appear
// somewhere inside it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLicense, passesQualityGate } from '../indexer/quality-gate.js';
import { PROD_OBSERVED_LICENSES } from '../lib/licenses.js';

const track = (license) => ({ title: 'A Tune', artist_name: 'Some Band', duration_seconds: 200, license });

test('negated or qualified "public domain" strings are not public domain', () => {
  for (const raw of [
    'not public domain',
    'Not Public Domain',
    'public domain in some countries only',
    'no known public domain status',
    'Not in the public domain',
    'public domain?',
    'non-public domain',
    'Public domain outside the United States only',
    'not public domain mark',
    'Public Domain Mark does not apply',
    'no PDM',
    'not PDM-owner',
    'not pd',
    '<a href="https://example.org/rights">not public domain</a>',
    // a Creative Commons URL inside a sentence is not a license either
    'not https://creativecommons.org/publicdomain/mark/1.0/',
    'Not public domain; see https://creativecommons.org/publicdomain/zero/1.0/',
    'not licensed under creativecommons.org/licenses/publicdomain',
    'http://creativecommons.org/publicdomain/mark/1.0/ (not applicable)',
  ]) {
    assert.notEqual(normalizeLicense(raw), 'public-domain', raw);
    const gate = passesQualityGate(track(raw));
    assert.equal(gate.ok, false, raw);
    assert.match(gate.reason, /^license /, raw);
  }
});

test('every public-domain spelling the resolvers emit still maps to public-domain', () => {
  for (const raw of [
    // canonical slug: archive.js, archive_pd78s, ucsb_cylinders, loc_jukebox, PROD_OBSERVED_LICENSES
    'public-domain',
    'pd',
    // Wikimedia LicenseShortName values, plain and HTML-wrapped
    'Public domain', 'PD', 'PDM-owner', 'PDM', 'PDM 1.0', 'Public Domain Mark', 'Public Domain Mark 1.0',
    '<a href="https://commons.wikimedia.org/wiki/Public_domain">Public domain</a>',
    '  Public Domain  ',
    // upper-cased by the Musopen resolver
    'PUBLIC DOMAIN', 'CC-PD',
    'cc-publicdomain', 'publicdomain',
    'Public Domain Dedication',
    // Internet Archive licenseurl, Wikimedia LicenseUrl and Europeana rights URL forms
    'https://creativecommons.org/publicdomain/mark/1.0/',
    'http://creativecommons.org/publicdomain/mark/1.0/',
    'https://creativecommons.org/publicdomain/zero/1.0/',
    'http://creativecommons.org/publicdomain/zero/1.0/',
    'http://creativecommons.org/licenses/publicdomain/',
  ]) {
    assert.equal(normalizeLicense(raw), 'public-domain', raw);
    const t = track(raw);
    assert.deepEqual(passesQualityGate(t), { ok: true, reason: null }, raw);
    assert.equal(t.license, 'public-domain', raw);
  }
});

test('a Creative Commons URL counts only as the whole value, in every shape upstream uses', () => {
  for (const raw of [
    'not https://creativecommons.org/licenses/by/3.0/',
    'Not under https://creativecommons.org/licenses/by-nc-sa/4.0/ any more',
    'https://creativecommons.org/licenses/by/4.0/ (withdrawn)',
    'https://example.org/creativecommons.org/licenses/by/3.0/',
    'https://notcreativecommons.org/licenses/by/3.0/',
    'https://creativecommons.org.example.com/licenses/by/3.0/',
  ]) {
    assert.equal(normalizeLicense(raw), null, raw);
    assert.equal(passesQualityGate(track(raw)).ok, false, raw);
  }
  for (const [raw, slug] of [
    ['https://creativecommons.org/licenses/by/3.0/', 'cc-by'],
    ['http://creativecommons.org/licenses/by/3.0/', 'cc-by'],
    ['https://creativecommons.org/licenses/by-sa/4.0', 'cc-by-sa'],
    ['http://www.creativecommons.org/licenses/by-nc/2.5/', 'cc-by-nc'],
    ['https://creativecommons.org/licenses/by-nc-sa/2.0/de/', 'cc-by-nc-sa'],
    ['http://creativecommons.org/licenses/by-nc-nd/3.0/us/', 'cc-by-nc-nd'],
    ['https://creativecommons.org/licenses/by/4.0/legalcode', 'cc-by'],
    ['https://creativecommons.org/licenses/by-sa/3.0/deed.en', 'cc-by-sa'],
    ['https://creativecommons.org/licenses/by-sa/3.0/de/deed.en', 'cc-by-sa'],
    ['https://creativecommons.org/licenses/by/4.0/?ref=chooser-v1', 'cc-by'],
    ['https://creativecommons.org/licenses/by/4.0/legalcode.en#s3', 'cc-by'],
    ['HTTPS://CreativeCommons.org/licenses/BY-NC-ND/4.0/', 'cc-by-nc-nd'],
    ['//creativecommons.org/licenses/by/3.0/', 'cc-by'],
    ['creativecommons.org/licenses/by/3.0/', 'cc-by'],
    ['https://creativecommons.org/licenses/by-nd-nc/1.0/', 'cc-by-nc-nd'],
    ['  https://creativecommons.org/licenses/by-nc-sa/4.0/  ', 'cc-by-nc-sa'],
    ['<a href="https://creativecommons.org/licenses/by-sa/4.0">https://creativecommons.org/licenses/by-sa/4.0</a>', 'cc-by-sa'],
    ['https://creativecommons.org/publicdomain/zero/1.0/deed.en', 'public-domain'],
    ['https://creativecommons.org/licenses/publicdomain', 'public-domain'],
  ]) {
    assert.equal(normalizeLicense(raw), slug, raw);
  }
});

test('the production-observed license values normalize as before', () => {
  // Expected slug per raw value; null = the gate does not recognize it.
  const expected = {
    'cc-by-nc-sa': 'cc-by-nc-sa', 'cc-by-nc-nd': 'cc-by-nc-nd', 'cc-by-nc': 'cc-by-nc',
    'public-domain': 'public-domain', 'cc-by-sa': 'cc-by-sa', 'taper-policy': 'taper-policy',
    'cc-by': 'cc-by', 'cc-by-nd': 'cc-by-nd', 'all-rights-reserved': null,
    'audius-platform': 'audius-platform', 'nc-sampling-plus': 'nc-sampling-plus',
    'sampling-plus': 'sampling-plus', 'cc0': 'cc0',
    'Attribution Noncommercial  (3.0)': 'cc-by-nc', 'Attribution (3.0)': 'cc-by',
    'Noncommercial Sampling Plus': 'nc-sampling-plus', 'Sampling Plus': 'sampling-plus',
    'Attribution Noncommercial': 'cc-by-nc', 'Attribution (4.0)': 'cc-by', 'Attribution': 'cc-by',
    'by-nc-nd': 'cc-by-nc-nd', 'CC': null, 'by-nc-sa': 'cc-by-nc-sa', 'by-sa': 'cc-by-sa',
    'by': 'cc-by', 'by-nd': 'cc-by-nd', 'by-nc': 'cc-by-nc', 'free-art': null,
  };
  assert.deepEqual(Object.keys(expected).sort(), [...PROD_OBSERVED_LICENSES].sort());
  for (const raw of PROD_OBSERVED_LICENSES) {
    assert.equal(normalizeLicense(raw), expected[raw], raw);
  }
  // The only public-domain spelling among them.
  assert.deepEqual(PROD_OBSERVED_LICENSES.filter((raw) => normalizeLicense(raw) === 'public-domain'), ['public-domain']);
});
