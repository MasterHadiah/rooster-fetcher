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
      console.log('   Pagina URL:', page.url());
    }

    const html1 = await page.content();
    console.log('   HTML bevat dxo:', html1.includes('dxo.'));
    console.log('   HTML bevat mySchedule:', html1.includes('mySchedule'));
    const aptIdx = html1.indexOf('AddAppointment');
    console.log('   AddAppointment context:', html1.slice(aptIdx - 20, aptIdx + 100));
    const aptIdx2 = html1.indexOf('AddAppointment("0"');
    console.log('   Volledige apt0:', html1.slice(aptIdx2, aptIdx2 + 400)); 
    const week1 = parseEduflex(html1);
    console.log(`   Week 1 (huidig): ${week1.length} items`);

    // Stap 3: Navigeer naar volgende week
    let week2 = [];
    try {
      // Klik op de "volgende week" knop
      const volgendeWeekSelector = [
        'input[title*="olgende"]',
        'a[title*="olgende"]',
        '[id*="next"]',
        '[id*="Next"]',
        '[id*="forward"]',
      ].join(', ');

      await Promise.all([
        page.waitForFunction(
          () => document.body.innerHTML.includes('AddAppointment'),
          { timeout: 15000 }
        ).catch(() => {}),
        page.click(volgendeWeekSelector),
      ]);

      await new Promise(r => setTimeout(r, 2000)); // even wachten tot rooster ververst

      const html2 = await page.content();
      week2 = parseEduflex(html2);
      console.log(`   Week 2 (volgend): ${week2.length} items`);
    } catch(e) {
      console.warn('   Week 2 overgeslagen:', e.message);
    }

    const all = [...week1, ...week2];
    const seen = new Set();
    const deduped = all.filter(i => {
      const k = `${i.startISO}|${i.vak}`;
      return seen.has(k) ? false : seen.add(k);
    });

    console.log(`✅ Eduflex totaal: ${deduped.length} afspraken`);
    return deduped;

  } finally {
    await browser.close();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 Rooster fetcher gestart\n');

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

  // Merge: prefer Eduflex for duplicate lessons
  const eduKeys = new Set(eduflexItems.map(i => {
    if (!i.startISO) return null;
    return `${Math.round(new Date(i.startISO).getTime()/600000)}|${(i.vak||'').split(' ')[0].toLowerCase()}`;
  }).filter(Boolean));

  const magFiltered = magisterItems.filter(i => {
    if (!i.startISO) return true;
    const k = `${Math.round(new Date(i.startISO).getTime()/600000)}|${(i.vak||'').split(' ')[0].toLowerCase()}`;
    return !eduKeys.has(k);
  });

  const combined = [...eduflexItems, ...magFiltered].sort((a, b) =>
    (a.startISO || '').localeCompare(b.startISO || '')
  );

  const output = { bijgewerkt: new Date().toISOString(), totaal: combined.length, afspraken: combined, fouten };
  fs.writeFileSync(path.join(__dirname, 'rooster.json'), JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n✅ rooster.json: ${combined.length} afspraken (Eduflex: ${eduflexItems.length}, Magister: ${magFiltered.length})`);
}

main().catch(err => { console.error('💥', err); process.exit(1); });