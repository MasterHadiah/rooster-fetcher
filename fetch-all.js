const fs    = require('fs');
const path  = require('path');
const https = require('https');

// ── Helpers ───────────────────────────────────────────────────────────────

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url.replace('webcal://', 'https://'), res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function parseICS(icsText, bron) {
  const items = [];
  const events = icsText.split('BEGIN:VEVENT');
  events.shift(); // remove header

  events.forEach(event => {
    const get = (key) => {
      const match = event.match(new RegExp(key + '[^:]*:(.+)'));
      return match ? match[1].trim() : null;
    };

    const dtstart = get('DTSTART');
    const dtend   = get('DTEND');
    const summary = get('SUMMARY');
    const location= get('LOCATION');
    const desc    = get('DESCRIPTION');

    if (!summary) return;

    // Parse ICS datetime: 20260323T083000Z or 20260323T083000
    function parseICSDate(str) {
      if (!str) return null;
      const s = str.replace('Z','');
      return new Date(
        `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T${s.slice(9,11)}:${s.slice(11,13)}:${s.slice(13,15)}${str.endsWith('Z') ? 'Z' : ''}`
      ).toISOString();
    }

    const startISO = parseICSDate(dtstart);
    const eindISO  = parseICSDate(dtend);

    const startDate = startISO ? new Date(startISO) : null;
    const eindDate  = eindISO  ? new Date(eindISO)  : null;

    items.push({
      vak:      summary,
      tijd:     startDate && eindDate
                  ? `${startDate.toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit'})} - ${eindDate.toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit'})}`
                  : null,
      lokaal:   location || null,
      groep:    desc     || null,
      datum:    startDate
                  ? startDate.toLocaleDateString('nl-NL',{weekday:'short',day:'2-digit',month:'2-digit',year:'numeric'})
                  : null,
      startISO,
      eindISO,
      bron,
    });
  });

  return items;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 Rooster fetcher gestart\n');

  const MAGISTER_ICAL = 'webcal://calendar.magister.net/api/icalendar/feeds/6e10ca93-b89c-470a-9a72-a5edaf092995';
  const EDUFLEX_ICAL  = process.env.EDUFLEX_ICAL || null;

  let items = [];
  let fouten = {};

  // ── Magister iCal ────────────────────────────────────────────────────────
  try {
    console.log('📅 Magister iCal ophalen...');
    const ics = await httpsGet(MAGISTER_ICAL);
    const magisterItems = parseICS(ics, 'magister');
    console.log(`✅ Magister: ${magisterItems.length} afspraken`);
    items.push(...magisterItems);
  } catch (err) {
    console.error('❌ Magister mislukt:', err.message);
    fouten.magister = err.message;
  }

  // ── Eduflex (optioneel via iCal, anders Puppeteer) ───────────────────────
  if (EDUFLEX_ICAL) {
    try {
      console.log('📅 Eduflex iCal ophalen...');
      const ics = await httpsGet(EDUFLEX_ICAL);
      const eduflexItems = parseICS(ics, 'eduflex');
      console.log(`✅ Eduflex: ${eduflexItems.length} afspraken`);
      items.push(...eduflexItems);
    } catch (err) {
      console.error('❌ Eduflex mislukt:', err.message);
      fouten.eduflex = err.message;
    }
  } else {
    console.log('ℹ️  Geen EDUFLEX_ICAL ingesteld, Eduflex overgeslagen');
    fouten.eduflex = 'Geen iCal link ingesteld';
  }

  // ── Sorteren & opslaan ───────────────────────────────────────────────────
  items.sort((a, b) => {
    if (a.startISO && b.startISO) return a.startISO.localeCompare(b.startISO);
    if (a.startISO) return -1;
    if (b.startISO) return 1;
    return 0;
  });

  const output = {
    bijgewerkt: new Date().toISOString(),
    totaal:     items.length,
    afspraken:  items,
    fouten,
  };

  const outputFile = path.join(__dirname, '..', 'rooster.json');
  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n✅ rooster.json geschreven met ${items.length} afspraken`);
}

main().catch(err => {
  console.error('💥 Onverwachte fout:', err);
  process.exit(1);
});
