const fs   = require('fs');
const path = require('path');

const { getEduflexRooster } = require('./eduflex');

const OUTPUT_FILE = path.join(__dirname, '..', 'rooster.json');

async function main() {
  console.log('🚀 Rooster fetcher gestart\n');

  let items = [];
  let fout  = null;

  try {
    items = await getEduflexRooster();
  } catch (err) {
    console.error('❌ Eduflex mislukt:', err.message);
    fout = err.message;
  }

  const output = {
    bijgewerkt: new Date().toISOString(),
    totaal:     items.length,
    afspraken:  items,
    fouten: {
      eduflex: fout,
    },
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n✅ rooster.json geschreven met ${items.length} afspraken`);

  if (fout) {
    console.error('\n💥 Eduflex is mislukt!');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('💥 Onverwachte fout:', err);
  process.exit(1);
});
