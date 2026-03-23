/**
 * fetch-all.js
 * Orchestrates Eduflex + Magister fetching and writes rooster.json.
 * This is the entry point called by the GitHub Actions workflow.
 */

const fs   = require('fs');
const path = require('path');

const { getEduflexRooster }  = require('./eduflex');
const { getMagisterRooster } = require('./magister');

const OUTPUT_FILE = path.join(__dirname, '..', 'rooster.json');

async function main() {
  console.log('🚀 Rooster fetcher gestart\n');

  const resultaten = {
    eduflex:  { items: [], error: null },
    magister: { items: [], error: null },
  };

  // ── Fetch Eduflex ─────────────────────────────────────────────────────────
  try {
    resultaten.eduflex.items = await getEduflexRooster();
  } catch (err) {
    console.error('❌ Eduflex mislukt:', err.message);
    resultaten.eduflex.error = err.message;
  }

  // ── Fetch Magister ────────────────────────────────────────────────────────
  try {
    resultaten.magister.items = await getMagisterRooster();
  } catch (err) {
    console.error('❌ Magister mislukt:', err.message);
    resultaten.magister.error = err.message;
  }

  // ── Merge & sort ──────────────────────────────────────────────────────────
  // Prefer Magister items for sorting (they have ISO timestamps).
  // Eduflex items without timestamps are appended at the end.
  const alles = [
    ...resultaten.magister.items,
    ...resultaten.eduflex.items,
  ].sort((a, b) => {
    if (a.startISO && b.startISO) return a.startISO.localeCompare(b.startISO);
    if (a.startISO) return -1;
    if (b.startISO) return 1;
    return 0;
  });

  // ── Write output ──────────────────────────────────────────────────────────
  const output = {
    bijgewerkt:    new Date().toISOString(),
    totaal:        alles.length,
    afspraken:     alles,
    fouten: {
      eduflex:  resultaten.eduflex.error,
      magister: resultaten.magister.error,
    },
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n✅ rooster.json geschreven met ${alles.length} afspraken`);
  console.log(`   Bestand: ${OUTPUT_FILE}`);

  // Exit with error code if BOTH sources failed (so GitHub Actions marks the run as failed)
  if (resultaten.eduflex.error && resultaten.magister.error) {
    console.error('\n💥 Beide bronnen zijn mislukt!');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('💥 Onverwachte fout:', err);
  process.exit(1);
});
