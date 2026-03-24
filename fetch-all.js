const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const puppeteer = require('puppeteer');

// ── Generic HTTPS helper (voor Magister iCal) ─────────────────────────────────

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location).then(resolve).catch(reject);
      }
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

// ── Parse Magister iCal ───────────────────────────────────────────────────────

function parseICS(text) {
  const items = [];
  text.split('BEGIN:VEVENT').slice(1).forEach(ev => {
    const get = k => { const m = ev.match(new RegExp(k + '[^:]*:(.+)')); return m ? m[1].trim() : null; };
    const summary = get('SUMMARY');
    if (!summary) return;

    function parseDate(s) {
      if (!s) return null;
      try {
        s = s.replace('Z','').replace(/\r/g,'');
        if (s.length === 8) return new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T00:00:00`).toISOString();
        return new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T${s.slice(9,11)}:${s.slice(11,13)}:${s.slice(13,15)}Z`).toISOString();
      } catch(e) { return null; }
    }

    const startISO = parseDate(get('DTSTART'));
    const eindISO  = parseDate(get('DTEND'));
    const startD   = startISO ? new Date(startISO) : null;
    const eindD    = eindISO  ? new Date(eindISO)  : null;

    items.push({
      vak:     summary,
      tijd:    startD && eindD ? `${startD.toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit'})} - ${eindD.toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit'})}` : null,
      lokaal:  get('LOCATION'),
      groep:   null,
      datum:   startD ? startD.toLocaleDateString('nl-NL',{weekday:'short',day:'2-digit',month:'2-digit',year:'numeric'}) : null,
      startISO, eindISO,
      bron:    'magister',
    });
  });
  return items;
}

// ── Parse Eduflex HTML (AddAppointment calls) ─────────────────────────────────
// FIX: Trek 1 uur af van alle Eduflex tijden omdat ze een uur te laat worden weergegeven

function parseEduflex(html) {
  const items = [];
  const re = /\w+\.AddAppointment\("(\d+)",\s*new Date\((\d+),(\d+),(\d+),(\d+),(\d+)\),\s*(\d+),\s*\[[^\]]*\],\s*"[^"]*",\s*"[^"]*",\s*"[^"]*",\s*"[^"]*",\s*[\d,\s]+,\(\{([^}]+)\}\)\)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const [,, yr, mo, dy, hr, mn, dur, propsStr] = m;
    const props = {};
    let pm;
    const pr = /'(\w+)':'([^']*)'/g;
    while ((pm = pr.exec(propsStr)) !== null) props[pm[1]] = pm[2];

    // 🔧 FIX: Trek 1 uur af van de Eduflex tijden
    const correctedHour = +hr - 1;
    const correctedHourStr = String(correctedHour).padStart(2, '0');
    
    const startStr = `${correctedHourStr}:${String(+mn).padStart(2,'0')}`;
    const eindMs   = (correctedHour * 60 + +mn) * 60000 + +dur;
    const eindH    = Math.floor(eindMs / 3600000);
    const eindM    = Math.floor((eindMs % 3600000) / 60000);
    const eindStr  = `${String(eindH).padStart(2,'0')}:${String(eindM).padStart(2,'0')}`;

    // Bouw datum string
    const dagen   = ['zo','ma','di','wo','do','vr','za'];
    const dagNr   = new Date(+yr, +mo, +dy).getDay();
    const datumStr = `${dagen[dagNr]} ${String(+dy).padStart(2,'0')}-${String(+mo+1).padStart(2,'0')}-${yr}`;

    // ISO string met de gecorrigeerde uren
    const startISO = `${yr}-${String(+mo+1).padStart(2,'0')}-${String(+dy).padStart(2,'0')}T${startStr}:00.000Z`;
    const eindISO  = `${yr}-${String(+mo+1).padStart(2,'0')}-${String(+dy).padStart(2,'0')}T${eindStr}:00.000Z`;

    const vak  = props.cpVak       || null;
    const attr = props.cpAttribuut || null;
    if (!vak && !attr) continue;

    items.push({
      vak:     vak ? (attr ? `${vak} (${attr})` : vak) : `Extra: ${attr}`,
      tijd:    `${startStr} - ${eindStr}`,
      lokaal:  props.cpLokaal || null,
      groep:   props.cpKlas   || null,
      datum:   datumStr,
      startISO,
      eindISO,
      kleur:   props.cpKleur  || null,
      bron:    'eduflex',
    });
  }
  return items;
}

// ── Fetch Eduflex via Puppeteer ───────────────────────────────────────────────

async function getEduflex() {
  const user = process.env.EDUFLEX_USER;
  const pass = process.env.EDUFLEX_PASS;
  if (!user || !pass) throw new Error('Geen EDUFLEX credentials');

  console.log('🔑 Eduflex: browser starten...');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // Stap 1: Login
    console.log('   Navigeren naar loginpagina...');
    await page.goto('https://web.eduflexcloud.nl/JA/webma/Pages/Login?ReturnUrl=%2fJA%2fwebma%2fPages%2fDefault', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // Vul gebruikersnaam en wachtwoord in
    await page.waitForSelector('input[type="password"]', { timeout: 10000 });
    await page.type('input[id*="Gebruikersnaam"], input[id*="gebruiker"], input[type="text"]', user, { delay: 30 });
    await page.type('input[type="password"]', pass, { delay: 30 });

    // Klik op inloggen
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
      page.click('input[type="submit"], button[type="submit"]'),
    ]);

    console.log('✅ Eduflex: ingelogd, pagina:', await page.title());

    // Stap 2: Navigeer naar DocentRooster
    await page.goto('https://web.eduflexcloud.nl/JA/webma/Pages/DocentRooster', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // Wacht tot het rooster geladen is
    try {
      await page.waitForFunction(
        () => document.body.innerHTML.includes('AddAppointment'),
        { timeout: 20000 }
      );
      console.log('   ✅ AddAppointment gevonden in pagina');
    } catch(e) {
      console.warn('   ⚠️ Timeout - AddAppointment niet gevonden, pagina titel:', await page.title());
    }

    // Week 1 ophalen
    const html1 = await page.content();
    const week1 = parseEduflex(html1);
    console.log(`   Week 1 (huidig): ${week1.length} items`);

    // Week 2 ophalen - verbeterde navigatie
    let week2 = [];
    try {
      console.log('   🔍 Zoeken naar "volgende week" knop...');
      
      // Meerdere mogelijke selectors voor de volgende week knop
      const mogelijkeSelectors = [
        'a[title*="Volgende"]',
        'a[title*="volgende"]',
        'button[title*="Volgende"]',
        'button[title*="volgende"]',
        'span[title*="Volgende"]',
        'div[title*="Volgende"]',
        '[aria-label*="Volgende"]',
        '[aria-label*="volgende"]',
        '.next',
        '.dxo-next',
        '.dx-nav-next',
        'a:has-text(">")',
        'button:has-text(">")',
        'a:has-text("Volgende")',
        'button:has-text("Volgende")'
      ];
      
      let gevonden = false;
      for (const selector of mogelijkeSelectors) {
        const knop = await page.$(selector);
        if (knop) {
          console.log(`   ✅ Knop gevonden met selector: ${selector}`);
          await knop.click();
          gevonden = true;
          break;
        }
      }
      
      if (!gevonden) {
        // Probeer alternatieve methode: zoek naar alle knoppen en check tekst
        const alleKnoppen = await page.$$('a, button, span, div');
        for (const knop of alleKnoppen) {
          const tekst = await page.evaluate(el => el.textContent || el.title || '', knop);
          if (tekst.toLowerCase().includes('volgende') || tekst === '>' || tekst === '→') {
            console.log(`   ✅ Knop gevonden met tekst: ${tekst}`);
            await knop.click();
            gevonden = true;
            break;
          }
        }
      }
      
      if (gevonden) {
        // Wacht tot het rooster ververst is
        await new Promise(r => setTimeout(r, 3000));
        
        // Wacht tot nieuwe AddAppointment calls geladen zijn
        await page.waitForFunction(
          () => document.body.innerHTML.includes('AddAppointment'),
          { timeout: 10000 }
        ).catch(() => console.log('   ⚠️ Timeout wachten op nieuwe data, maar ga verder...'));
        
        const html2 = await page.content();
        week2 = parseEduflex(html2);
        console.log(`   Week 2 (volgend): ${week2.length} items`);
      } else {
        console.log('   ⚠️ Geen "volgende week" knop gevonden, alleen week 1 geladen');
      }
      
    } catch(e) {
      console.warn('   Week 2 overgeslagen:', e.message);
    }

    const all = [...week1, ...week2];
    const seen = new Set();
    const deduped = all.filter(i => {
      const k = `${i.startISO}|${i.vak}`;
      return seen.has(k) ? false : seen.add(k);
    });

    console.log(`✅ Eduflex totaal: ${deduped.length} afspraken (week1: ${week1.length}, week2: ${week2.length})`);
    return deduped;

  } finally {
    await browser.close();
  }
}

// ── Vakantiecheck (leest vakanties.json) ─────────────────────────────────────

function isVakantieOfVrijeDag() {
  const vandaag = new Date();
  vandaag.setHours(0, 0, 0, 0);
  const vandaagStr = vandaag.toISOString().slice(0, 10);

  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(__dirname, 'vakanties.json'), 'utf8'));
  } catch(e) {
    console.log('   ℹ️ Geen vakanties.json gevonden, ga gewoon door.');
    return false;
  }

  // Check vakanties
  for (const v of (data.vakanties || [])) {
    if (vandaagStr >= v.start && vandaagStr <= v.eind) {
      console.log(`🏖️ Het is ${v.naam} (${v.start} t/m ${v.eind}), script stopt.`);
      return true;
    }
  }

  // Check vrije dagen
  for (const v of (data.vrije_dagen || [])) {
    if (vandaagStr === v.datum) {
      console.log(`📅 Vandaag is een vrije dag: ${v.naam} (${v.datum}), script stopt.`);
      return true;
    }
  }

  return false;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 Rooster fetcher gestart\n');

 
// Sla over tijdens vakanties en vrije dagen
  if (isVakantieOfVrijeDag()) {
    // Verwijder afspraken van vandaag en later uit rooster.json
    try {
      const bestaand = JSON.parse(fs.readFileSync(path.join(__dirname, 'rooster.json'), 'utf8'));
      const vandaag = new Date().toISOString().slice(0, 10);
      bestaand.afspraken = bestaand.afspraken.filter(a => 
        a.startISO && a.startISO.slice(0, 10) < vandaag
      );
      bestaand.totaal = bestaand.afspraken.length;
      bestaand.bijgewerkt = new Date().toISOString();
      fs.writeFileSync(path.join(__dirname, 'rooster.json'), JSON.stringify(bestaand, null, 2), 'utf8');
      console.log('🗑️ Toekomstige afspraken verwijderd uit rooster.json');
    } catch(e) {}
    return;
  }
  const MAGISTER_ICAL = 'https://calendar.magister.net/api/icalendar/feeds/6e10ca93-b89c-470a-9a72-a5edaf092995';

  let magisterItems = [], eduflexItems = [];
  const fouten = {};

  // Magister
  try {
    console.log('📅 Magister iCal ophalen...');
    const body = await get(MAGISTER_ICAL);
    magisterItems = parseICS(body);
    console.log(`✅ Magister: ${magisterItems.length} afspraken`);
  } catch(e) {
    console.error('❌ Magister mislukt:', e.message);
    fouten.magister = e.message;
  }

  // Eduflex
  try {
    eduflexItems = await getEduflex();
  } catch(e) {
    console.error('❌ Eduflex mislukt:', e.message);
    fouten.eduflex = e.message;
  }

  // 🔧 NIEUWE MERGE LOGICA: Magister heeft voorrang voor lessen
  // Maak een set van Magister tijden (afgerond op 10 minuten)
  const magKeys = new Set(magisterItems.map(i => {
    if (!i.startISO) return null;
    const startTime = new Date(i.startISO);
    const roundedMinutes = Math.round(startTime.getMinutes() / 10) * 10;
    const roundedTime = new Date(startTime);
    roundedTime.setMinutes(roundedMinutes);
    return `${roundedTime.getTime()}`;
  }).filter(Boolean));

  // Filter Eduflex items die NIET overlappen met Magister
  const eduflexFiltered = eduflexItems.filter(i => {
    if (!i.startISO) return false;
    const startTime = new Date(i.startISO);
    const roundedMinutes = Math.round(startTime.getMinutes() / 10) * 10;
    const roundedTime = new Date(startTime);
    roundedTime.setMinutes(roundedMinutes);
    const timeKey = `${roundedTime.getTime()}`;
    
    // Alleen Eduflex tonen als er GEEN Magister les is op dezelfde tijd
    return !magKeys.has(timeKey);
  });

  // Combineer: alle Magister lessen + Eduflex extra afspraken (die niet overlappen)
  const combined = [...magisterItems, ...eduflexFiltered].sort((a, b) =>
    (a.startISO || '').localeCompare(b.startISO || '')
  );

  const output = { bijgewerkt: new Date().toISOString(), totaal: combined.length, afspraken: combined, fouten };
  fs.writeFileSync(path.join(__dirname, 'rooster.json'), JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n✅ rooster.json: ${combined.length} afspraken (Magister: ${magisterItems.length}, Eduflex extra: ${eduflexFiltered.length})`);
}

main().catch(err => { console.error('💥', err); process.exit(1); });
