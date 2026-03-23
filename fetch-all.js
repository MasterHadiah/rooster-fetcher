const fs    = require('fs');
const path  = require('path');
const https = require('https');

// ── Generic HTTPS helpers ─────────────────────────────────────────────────────

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location.startsWith('http')
          ? res.headers.location
          : 'https://web.eduflexcloud.nl' + res.headers.location;
        return get(loc).then(resolve).catch(reject);
      }
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ body: d, headers: res.headers }));
    }).on('error', reject);
  });
}

function getWithCookies(urlPath, cookieStr) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'web.eduflexcloud.nl',
      path: urlPath,
      method: 'GET',
      headers: { 'Cookie': cookieStr }
    };
    const req = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ body: d, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

function post(urlPath, data, cookieStr) {
  return new Promise((resolve, reject) => {
    const postData = typeof data === 'string' ? data : new URLSearchParams(data).toString();
    const opts = {
      hostname: 'web.eduflexcloud.nl',
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'Cookie': cookieStr || '',
      }
    };
    const req = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ body: d, headers: res.headers }));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function parseCookies(headers, jar = {}) {
  const raw = headers['set-cookie'] || [];
  (Array.isArray(raw) ? raw : [raw]).forEach(c => {
    const [pair] = c.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  });
  return jar;
}

function cookieStr(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
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

function parseEduflex(html) {
  const items = [];
  const re = /dxo\.AddAppointment\("(\d+)",\s*new Date\((\d+),(\d+),(\d+),(\d+),(\d+)\),\s*(\d+),[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,\(\{([^}]+)\}\)\)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const [,, yr, mo, dy, hr, mn, dur, propsStr] = m;
    const props = {};
    let pm;
    const pr = /'(\w+)':'([^']*)'/g;
    while ((pm = pr.exec(propsStr)) !== null) props[pm[1]] = pm[2];

    const startD = new Date(+yr, +mo, +dy, +hr, +mn);
    const eindD  = new Date(startD.getTime() + +dur);

    const vak  = props.cpVak  || null;
    const attr = props.cpAttribuut || null;
    if (!vak && !attr) continue;

    items.push({
      vak:     vak ? (attr ? `${vak} (${attr})` : vak) : `Extra: ${attr}`,
      tijd:    `${startD.toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit'})} - ${eindD.toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit'})}`,
      lokaal:  props.cpLokaal || null,
      groep:   props.cpKlas   || null,
      datum:   startD.toLocaleDateString('nl-NL',{weekday:'short',day:'2-digit',month:'2-digit',year:'numeric'}),
      startISO: startD.toISOString(),
      eindISO:  eindD.toISOString(),
      kleur:   props.cpKleur  || null,
      bron:    'eduflex',
    });
  }
  return items;
}

// ── Fetch Eduflex ─────────────────────────────────────────────────────────────

async function getEduflex() {
  const user = process.env.EDUFLEX_USER;
  const pass = process.env.EDUFLEX_PASS;
  if (!user || !pass) throw new Error('Geen credentials');

  console.log('🔑 Eduflex: inloggen...');
  const jar = {};

  // 1. GET login page
  const r1 = await getWithCookies('/JA/webma/Pages/Default', '');
  parseCookies(r1.headers, jar);

  // 2. Extract hidden fields
  const vs  = r1.body.match(/id="__VIEWSTATE"\s+value="([^"]*)"/)?.[1] || '';
  const vsg = r1.body.match(/id="__VIEWSTATEGENERATOR"\s+value="([^"]*)"/)?.[1] || '';
  const ev  = r1.body.match(/id="__EVENTVALIDATION"\s+value="([^"]*)"/)?.[1] || '';

  // Find field names by looking for text input fields
  const uField = r1.body.match(/name="([^"]*(?:gebruiker|username)[^"]*)"[^>]*type="text"/i)?.[1]
              || r1.body.match(/type="text"[^>]*name="([^"]*(?:gebruiker|username)[^"]*)"/i)?.[1]
              || 'ctl00$ctl00$ContentBody$ContentBody$LoginControl1$txtGebruikersnaam';
  const pField = r1.body.match(/name="([^"]*(?:wachtwoord|password)[^"]*)"[^>]*type="password"/i)?.[1]
              || r1.body.match(/type="password"[^>]*name="([^"]*(?:wachtwoord|password)[^"]*)"/i)?.[1]
              || 'ctl00$ctl00$ContentBody$ContentBody$LoginControl1$txtWachtwoord';
  const bField = r1.body.match(/name="([^"]*(?:btnLogin|login)[^"]*)"[^>]*type="submit"/i)?.[1]
              || r1.body.match(/type="submit"[^>]*name="([^"]*(?:btnLogin|login)[^"]*)"/i)?.[1]
              || 'ctl00$ctl00$ContentBody$ContentBody$LoginControl1$btnLogin';

  // 3. POST login
  const loginData = new URLSearchParams({
    '__VIEWSTATE': vs, '__VIEWSTATEGENERATOR': vsg, '__EVENTVALIDATION': ev,
    [uField]: user, [pField]: pass, [bField]: 'Inloggen',
  }).toString();

  const r2 = await post('/JA/webma/Pages/Default', loginData, cookieStr(jar));
  parseCookies(r2.headers, jar);

  console.log('✅ Eduflex: ingelogd');

  // 4. GET rooster page
  const r3 = await getWithCookies('/JA/webma/Pages/DocentRooster', cookieStr(jar));
  parseCookies(r3.headers, jar);

  const week1 = parseEduflex(r3.body);
  console.log(`   Week 1: ${week1.length} items`);

  // 5. Try week 2 via next-week navigation
  // Extract scheduler state for callback
  const cbState = r3.body.match(/'callbackState':'([^']+)'/)?.[1] || '';
  const schedulerId = r3.body.match(/ASPx\.createControl\(ASPxClientScheduler,'([^']+)'/)?.[1]
                   || 'ctl00_ctl00_ContentBody_ContentBody_Rooster_mySchedule';

  const rvs  = r3.body.match(/id="__VIEWSTATE"\s+value="([^"]*)"/)?.[1] || '';
  const rvsg = r3.body.match(/id="__VIEWSTATEGENERATOR"\s+value="([^"]*)"/)?.[1] || '';
  const rev  = r3.body.match(/id="__EVENTVALIDATION"\s+value="([^"]*)"/)?.[1] || '';

  // Compute next Monday
  const today = new Date();
  const daysUntilNextMon = (8 - today.getDay()) % 7 || 7;
  const nextMon = new Date(today); nextMon.setDate(today.getDate() + daysUntilNextMon);
  nextMon.setHours(8, 0, 0, 0);

  let week2 = [];
  try {
    const cbData = new URLSearchParams({
      '__VIEWSTATE': rvs, '__VIEWSTATEGENERATOR': rvsg, '__EVENTVALIDATION': rev,
      '__CALLBACKID': schedulerId,
      '__CALLBACKPARAM': `c0:KV|8;AV|${nextMon.getTime()};`,
    }).toString();

    const r4 = await post('/JA/webma/Pages/DocentRooster', cbData, cookieStr(jar));
    week2 = parseEduflex(r4.body);
    console.log(`   Week 2: ${week2.length} items`);
  } catch(e) {
    console.warn('   Week 2 overgeslagen:', e.message);
  }

  const all = [...week1, ...week2];
  // Deduplicate
  const seen = new Set();
  return all.filter(i => {
    const k = `${i.startISO}|${i.vak}`;
    return seen.has(k) ? false : seen.add(k);
  });
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
    const { body } = await get(MAGISTER_ICAL);
    magisterItems = parseICS(body);
    console.log(`✅ Magister: ${magisterItems.length} afspraken`);
  } catch(e) {
    console.error('❌ Magister mislukt:', e.message);
    fouten.magister = e.message;
  }

  // Eduflex
  try {
    eduflexItems = await getEduflex();
    console.log(`✅ Eduflex totaal: ${eduflexItems.length} afspraken`);
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
