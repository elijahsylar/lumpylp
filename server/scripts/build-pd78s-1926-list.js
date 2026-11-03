// Build server/data/pd78s-1926-identifiers.txt: Internet Archive 78rpm items
// dated 1926 (year-only "1926", which IA indexes as 1926-01-01, and full
// 1926 dates). The pre-fix archive_pd78s query (date:[* TO 1926-01-01]) let
// the year-only ones in; under 17 USC 1401 they are protected until
// 2027-01-01. Migration 018 hides our rows from these items with
// pd_effective_on = 2027-01-01. Metadata only (identifier + date); no DB.
//
//   node scripts/build-pd78s-1926-list.js [--year=1926] > data/pd78s-1926-identifiers.txt
const year = Number((process.argv.find((a) => a.startsWith('--year=')) || '--year=1926').split('=')[1]);
const q = `collection:(78rpm) AND mediatype:(audio) AND date:[${year}-01-01 TO ${year}-12-31] AND -collection:(cylindertransfer)`;
const url = new URL('https://archive.org/advancedsearch.php');
url.searchParams.set('q', q);
url.searchParams.append('fl[]', 'identifier');
url.searchParams.append('fl[]', 'date');
url.searchParams.set('rows', '10000');
url.searchParams.set('output', 'json');
const res = await fetch(url, { headers: { 'User-Agent': 'LumpyLP/1.0 (relaunch maintenance; metadata only)' } });
if (!res.ok) { console.error(`IA search failed: ${res.status}`); process.exit(1); }
const { response } = await res.json();
if (response.numFound !== response.docs.length) {
  console.error(`expected ${response.numFound} docs, got ${response.docs.length}; raise rows or page`);
  process.exit(1);
}
const ids = response.docs.map((d) => d.identifier).sort();
const yearOnly = response.docs.filter((d) => String(d.date || '').startsWith(`${year}-01-01`)).length;
console.log(`# Internet Archive 78rpm items dated ${year}, fetched ${new Date().toISOString().slice(0, 10)}.`);
console.log(`# Query: ${q}`);
console.log(`# ${ids.length} identifiers (${yearOnly} year-only "${year}", ${ids.length - yearOnly} with a full date).`);
console.log(`# Built by scripts/build-pd78s-1926-list.js; used by migration 018.`);
for (const id of ids) console.log(id);
