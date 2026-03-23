/**
 * magister.js
 * Fetches teacher appointments from Magister for the coming 2 weeks.
 * Uses the magister.js library which wraps the official Magister API.
 * Returns an array of appointment objects in the same shape as eduflex.js.
 */

const { Magister } = require('magister.js');

async function getMagisterRooster() {
  const school    = process.env.MAGISTER_SCHOOL;   // e.g. "jouwschool" (subdomain only)
  const username  = process.env.MAGISTER_USER;
  const password  = process.env.MAGISTER_PASS;

  if (!school || !username || !password) {
    throw new Error(
      'MAGISTER_SCHOOL, MAGISTER_USER and MAGISTER_PASS environment variables are required'
    );
  }

  console.log('🔑 Magister: inloggen op', school + '.magister.net ...');

  const magister = await Magister.login({
    school: { url: `https://${school}.magister.net` },
    username,
    password,
  });

  console.log('✅ Magister: ingelogd als', magister.profileInfo.firstName);

  // Fetch appointments for today up to 14 days ahead
  const vandaag     = new Date();
  vandaag.setHours(0, 0, 0, 0);

  const eindDatum   = new Date(vandaag);
  eindDatum.setDate(vandaag.getDate() + 14);

  console.log(`   Ophalen: ${vandaag.toLocaleDateString('nl-NL')} t/m ${eindDatum.toLocaleDateString('nl-NL')}`);

  const afspraken = await magister.appointments(vandaag, eindDatum);

  const roosterItems = afspraken
    .filter(a => !a.cancelled) // Skip cancelled lessons (set to true to include them)
    .map(a => {
      // Format start/end times
      const startTijd = a.start ? a.start.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }) : null;
      const eindTijd  = a.end   ? a.end.toLocaleTimeString('nl-NL',   { hour: '2-digit', minute: '2-digit' }) : null;
      const datumStr  = a.start ? a.start.toLocaleDateString('nl-NL', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }) : null;

      return {
        vak:       a.description || a.subject?.description || 'Onbekend',
        tijd:      (startTijd && eindTijd) ? `${startTijd} - ${eindTijd}` : startTijd,
        lokaal:    a.location || null,
        groep:     a.classes?.join(', ') || null,
        datum:     datumStr,
        startISO:  a.start?.toISOString() || null,   // Used for sorting
        eindISO:   a.end?.toISOString()   || null,
        geannuleerd: a.cancelled || false,
        bron:      'magister',
      };
    });

  console.log(`✅ Magister totaal: ${roosterItems.length} afspraken`);
  return roosterItems;
}

// Allow running standalone for testing: node scripts/magister.js
if (require.main === module) {
  getMagisterRooster()
    .then(data => console.log(JSON.stringify(data, null, 2)))
    .catch(err => { console.error(err); process.exit(1); });
}

module.exports = { getMagisterRooster };
