const fs    = require('fs');
const path  = require('path');
const https = require('https');

// ── Helpers ───────────────────────────────────────────────────────────────────

function httpsGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url.replace('webcal://', 'https://'), options, res => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location, options).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function httpsPost(url, postData, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        ...headers,
      },
    };
    const req = https.request(options, res => {
      let data = '';
      // Capture cookies from login response
      resolve({ data: '', headers: res.headers, statusCode: res.statusCode,
        consume: () => new Promise(r => {
          res.on('data', c => data += c);
          res.on('end', () => r(data));
        })
      });
      res.on('data', c => data += c);
      res.on('end', () => {});
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(postData);
    req.end();
  });
}

// ── .NET Ticks → JavaScript Date ──────────────────────────────────────────────
// .NET ticks: 100-nanosecond intervals since 0001-01-01
// JavaScript Date: milliseconds since 1970-01-01
function ticksToDate(ticks) {
  const TICKS_PER_MS = 10000n;
  const EPOCH_DIFF_MS = 62135596800000n; // ms between 0001-01-01 and 1970-01-01
  const ms = BigInt(ticks) / TICKS_PER_MS - EPOCH_DIFF_MS;
  return new Date(Number(ms));
}

// ── Parse Magister iCal ───────────────────────────────────────────────────────
function parseICS(icsText, bron) {
  const items = [];
  const events = icsText.split('BEGIN:VEVENT');
  events.shift();

  events.forEach(event => {
    const get = (key) => {
      const match = event.match(new RegExp(key + '[^:]*:(.+)'));
      return match ? match[1].trim() : null;
    };

    const summary  = get('SUMMARY');
    const dtstart  = get('DTSTART');
    const dtend    = get('DTEND');
    const location = get('LOCATION');

    if (!summary) return;

    function parseICSDate(str) {
      if (!str) return null;
      try {
        const s = str.replace('Z', '').replace(/\r/g, '');
        if (s.length === 8) {
          return new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T00:00:00`).toISOString();
        }
        const datePart = `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
        const timePart = `${s.slice(9,11)}:${s.slice(11,13)}:${s.slice(13,15)}`;
        const suffix   = str.endsWith('Z') ? 'Z' : '';
        return new Date(`${datePart}T${timePart}${suffix}`).toISOString();
      } catch(e) { return null; }
    }

    const startISO = parseICSDate(dtstart);
    const eindISO  = parseICSDate(dtend);
    const startDate = startISO ? new Date(startISO) : null;
    const eindDate  = eindISO  ? new Date(eindISO)  : null;

    items.push({
      vak:     summary,
      tijd:    startDate && eindDate
                 ? `${startDate.toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit'})} - ${eindDate.toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit'})}`
                 : null,
      lokaal:  location || null,
      groep:   null,
      datum:   startDate ? startDate.toLocaleDateString('nl-NL',{weekday:'short',day:'2-digit',month:'2-digit',year:'numeric'}) : null,
      startISO,
      eindISO,
      bron,
    });
  });

  return items;
}

// ── Parse Eduflex XHR response ────────────────────────────────────────────────
// The response is a JS callback: s/*DX*/({'id':0,'result':{...'aptsBlock_innerContent':'<div ...>'...}})
// We extract the AddAppointment calls from the scriptBlock which contain structured data
function parseEduflexResponse(responseText) {
  const items = [];

  // Extract AddAppointment calls from the scriptBlock
  // Pattern: dxo.AddAppointment("N", new Date(y,m,d,h,min), durationMs, [...], "", "", ..., ({cpVak:'...', cpKlas:'...', ...}))
  const aptRegex = /dxo\.AddAppointment\("(\d+)",\s*new Date\((\d+),(\d+),(\d+),(\d+),(\d+)\),\s*(\d+),.*?\(\{([^}]+)\}\)\)/g;
  let match;

  while ((match = aptRegex.exec(responseText)) !== null) {
    const [, id, year, month, day, hour, min, durationMs, propsStr] = match;

    // Parse custom properties object: 'cpVak':'nsk1','cpKlas':'V4D',...
    const props = {};
    const propRegex = /'(\w+)':'([^']*)'/g;
    let propMatch;
    while ((propMatch = propRegex.exec(propsStr)) !== null) {
      props[propMatch[1]] = propMatch[2];
    }

    // Build start/end dates
    // month in JS Date is 0-based, and that's what Eduflex sends
    const startDate = new Date(
      parseInt(year), parseInt(month), parseInt(day),
      parseInt(hour), parseInt(min), 0, 0
    );
    const eindDate = new Date(startDate.getTime() + parseInt(durationMs));

    const startISO = startDate.toISOString();
    const eindISO  = eindDate.toISOString();

    // Determine description: prefer vak, fall back to attribuut
    const vak      = props.cpVak      || null;
    const attribuut= props.cpAttribuut|| null;
    const lokaal   = props.cpLokaal   || null;
    const klas     = props.cpKlas     || null;
    const kleur    = props.cpKleur    || null;

    // Skip if completely empty
    if (!vak && !attribuut) continue;

    const label = vak
      ? (attribuut ? `${vak} (${attribuut})` : vak)
      : `Extra code: ${attribuut}`;

    items.push({
      vak:     label,
      tijd:    `${startDate.toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit'})} - ${eindDate.toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit'})}`,
      lokaal:  lokaal || null,
      groep:   klas   || null,
      datum:   startDate.toLocaleDateString('nl-NL',{weekday:'short',day:'2-digit',month:'2-digit',year:'numeric'}),
      startISO,
      eindISO,
      kleur:   kleur  || null,
      bron:    'eduflex',
    });
  }

  return items;
}

// ── Fetch Eduflex ─────────────────────────────────────────────────────────────
async function getEduflexRooster() {
  const username = process.env.EDUFLEX_USER;
  const password = process.env.EDUFLEX_PASS;

  if (!username || !password) throw new Error('EDUFLEX_USER and EDUFLEX_PASS required');

  const BASE     = 'https://web.eduflexcloud.nl';
  const LOGIN    = `${BASE}/JA/webma/Pages/Default`;
  const ROOSTER  = `${BASE}/JA/webma/Pages/DocentRooster`;

  console.log('🔑 Eduflex: inloggen...');

  // Step 1: GET login page to get __VIEWSTATE and cookies
  const loginPageRaw = await httpsGet(LOGIN);

  // Extract hidden fields
  const getHidden = (name) => {
    const m = loginPageRaw.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`, 'i'))
           || loginPageRaw.match(new RegExp(`id="${name}"[^>]*value="([^"]*)"`, 'i'));
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  };

  // Extract cookies from login page response
  // We need to do a real cookie-aware session — use a simple cookie jar
  const cookieJar = {};

  const extractCookies = (setCookieHeaders) => {
    if (!setCookieHeaders) return;
    const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    headers.forEach(c => {
      const [pair] = c.split(';');
      const [name, val] = pair.split('=');
      if (name) cookieJar[name.trim()] = (val || '').trim();
    });
  };

  const cookieString = () => Object.entries(cookieJar).map(([k,v]) => `${k}=${v}`).join('; ');

  // GET login page and capture cookies
  await new Promise((resolve, reject) => {
    https.get(LOGIN, res => {
      extractCookies(res.headers['set-cookie']);
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    }).on('error', reject);
  });

  // Re-fetch login page with cookies to get VIEWSTATE
  let loginHtml = '';
  await new Promise((resolve, reject) => {
    const options = { headers: { 'Cookie': cookieString() } };
    https.get(LOGIN, options, res => {
      extractCookies(res.headers['set-cookie']);
      let d = ''; res.on('data', c => d += c); res.on('end', () => { loginHtml = d; resolve(); });
    }).on('error', reject);
  });

  const viewstate = loginHtml.match(/id="__VIEWSTATE"\s+value="([^"]*)"/)?.[1] || '';
  const vsg = loginHtml.match(/id="__VIEWSTATEGENERATOR"\s+value="([^"]*)"/)?.[1] || '';
  const evval = loginHtml.match(/id="__EVENTVALIDATION"\s+value="([^"]*)"/)?.[1] || '';

  // Find the username/password field names
  const userField = loginHtml.match(/id="[^"]*(?:gebruikersnaam|gebruiker|username|user)[^"]*"\s+name="([^"]*)"/i)?.[1]
                 || loginHtml.match(/name="([^"]*(?:gebruikersnaam|gebruiker|username|user)[^"]*)"/i)?.[1]
                 || 'ctl00$ctl00$ContentBody$ContentBody$LoginControl1$txtGebruikersnaam';
  const passField = loginHtml.match(/id="[^"]*(?:wachtwoord|password|pass)[^"]*"\s+name="([^"]*)"/i)?.[1]
                 || loginHtml.match(/name="([^"]*(?:wachtwoord|password|pass)[^"]*)"/i)?.[1]
                 || 'ctl00$ctl00$ContentBody$ContentBody$LoginControl1$txtWachtwoord';
  const btnField  = loginHtml.match(/id="[^"]*(?:btnLogin|login|submit)[^"]*"\s+name="([^"]*)"/i)?.[1]
                 || 'ctl00$ctl00$ContentBody$ContentBody$LoginControl1$btnLogin';

  // Step 2: POST login
  const params = new URLSearchParams({
    '__VIEWSTATE':          viewstate,
    '__VIEWSTATEGENERATOR': vsg,
    '__EVENTVALIDATION':    evval,
    [userField]:            username,
    [passField]:            password,
    [btnField]:             'Inloggen',
  });

  await new Promise((resolve, reject) => {
    const urlObj = new URL(LOGIN);
    const postData = params.toString();
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'Cookie': cookieString(),
      }
    }, res => {
      extractCookies(res.headers['set-cookie']);
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });

  console.log('✅ Eduflex: ingelogd');

  // Step 3: GET DocentRooster page to get its VIEWSTATE
  let roosterHtml = '';
  await new Promise((resolve, reject) => {
    https.get(ROOSTER, { headers: { 'Cookie': cookieString() } }, res => {
      extractCookies(res.headers['set-cookie']);
      let d = ''; res.on('data', c => d += c); res.on('end', () => { roosterHtml = d; resolve(); });
    }).on('error', reject);
  });

  const allItems = [];

  // Step 4: Fetch 2 weeks of data via POST (same as browser does on navigation)
  // The browser does a callback POST to get appointment data for each visible week
  // We can also just parse what's already in the initial page HTML

  // Parse initial week from roosterHtml
  const initialItems = parseEduflexResponse(roosterHtml);
  console.log(`   Week 1: ${initialItems.length} Eduflex items`);
  allItems.push(...initialItems);

  // Try to navigate to next week via POST callback
  try {
    const rvs   = roosterHtml.match(/id="__VIEWSTATE"\s+value="([^"]*)"/)?.[1] || '';
    const rvsg  = roosterHtml.match(/id="__VIEWSTATEGENERATOR"\s+value="([^"]*)"/)?.[1] || '';
    const revval= roosterHtml.match(/id="__EVENTVALIDATION"\s+value="([^"]*)"/)?.[1] || '';

    // Find the scheduler control name
    const schedulerName = roosterHtml.match(/ASPx\.GetControlCollection\(\)\.GetByName\('([^']+)'\)/)?.[1] || 'mySchedule';
    const schedulerId   = roosterHtml.match(/ASPxClientScheduler[^,]*,'([^']+mySchedule[^']+)'/)?.[1]
                       || 'ctl00_ctl00_ContentBody_ContentBody_Rooster_mySchedule';

    // Get visible days to compute next week
    const visibleDays = [...roosterHtml.matchAll(/'(\d+\/\d+\/\d+)'/g)].map(m => m[1]).slice(0, 5);
    if (visibleDays.length > 0) {
      // Parse last visible day and add 3 days (skip weekend) to get to next Monday
      const lastDay = visibleDays[visibleDays.length - 1].split('/');
      const nextMonday = new Date(parseInt(lastDay[2]), parseInt(lastDay[1])-1, parseInt(lastDay[0]) + 3);
      const nextMondayMs = nextMonday.getTime();

      const callbackParams = new URLSearchParams({
        '__VIEWSTATE':          rvs,
        '__VIEWSTATEGENERATOR': rvsg,
        '__EVENTVALIDATION':    revval,
        '__CALLBACKID':         schedulerId,
        '__CALLBACKPARAM':      `c0:{"command":"GotoDate","date":${nextMondayMs}}`,
      });

      const nextWeekData = await new Promise((resolve, reject) => {
        const urlObj = new URL(ROOSTER);
        const postData = callbackParams.toString();
        const req = https.request({
          hostname: urlObj.hostname,
          path: urlObj.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData),
            'Cookie': cookieString(),
            'X-Requested-With': 'XMLHttpRequest',
          }
        }, res => {
          let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
      });

      const week2Items = parseEduflexResponse(nextWeekData);
      console.log(`   Week 2: ${week2Items.length} Eduflex items`);
      allItems.push(...week2Items);
    }
  } catch(e) {
    console.warn('⚠️  Week 2 ophalen mislukt:', e.message);
  }

  // Deduplicate by startISO + vak
  const seen = new Set();
  const deduped = allItems.filter(item => {
    const key = `${item.startISO}|${item.vak}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`✅ Eduflex totaal: ${deduped.length} afspraken`);
  return deduped;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Rooster fetcher gestart\n');

  const MAGISTER_ICAL = 'webcal://calendar.magister.net/api/icalendar/feeds/6e10ca93-b89c-470a-9a72-a5edaf092995';

  let items  = [];
  let fouten = {};

  // Magister iCal
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

  // Eduflex
  if (process.env.EDUFLEX_USER && process.env.EDUFLEX_PASS) {
    try {
      const eduflexItems = await getEduflexRooster();
      items.push(...eduflexItems);
    } catch (err) {
      console.error('❌ Eduflex mislukt:', err.message);
      fouten.eduflex = err.message;
    }
  } else {
    console.log('ℹ️  Geen Eduflex credentials, overgeslagen');
    fouten.eduflex = 'Geen credentials';
  }

  // Dedup Magister vs Eduflex: als dezelfde les in beide zit, bewaar Eduflex versie
  // (want Eduflex heeft meer info zoals kleur en attribuut)
  const magisterKeys = new Set();
  const eduflex = items.filter(i => i.bron === 'eduflex');
  eduflex.forEach(i => {
    // Key: rounded start time (within 10 min) + vak
    if (i.startISO) {
      const rounded = Math.round(new Date(i.startISO).getTime() / 600000);
      magisterKeys.add(`${rounded}|${(i.vak||'').split(' ')[0].toLowerCase()}`);
    }
  });

  const magister = items.filter(i => {
    if (i.bron !== 'magister') return true;
    if (!i.startISO) return true;
    const rounded = Math.round(new Date(i.startISO).getTime() / 600000);
    const key = `${rounded}|${(i.vak||'').split(' ')[0].toLowerCase()}`;
    return !magisterKeys.has(key); // exclude if Eduflex has same lesson
  });

  const combined = [...eduflex, ...magister].sort((a, b) => {
    if (a.startISO && b.startISO) return a.startISO.localeCompare(b.startISO);
    if (a.startISO) return -1;
    if (b.startISO) return 1;
    return 0;
  });

  const output = {
    bijgewerkt: new Date().toISOString(),
    totaal:     combined.length,
    afspraken:  combined,
    fouten,
  };

  const outputFile = path.join(__dirname, 'rooster.json');
  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n✅ rooster.json geschreven met ${combined.length} afspraken`);
  console.log(`   Magister: ${magister.length}, Eduflex: ${eduflex.length}`);
}

main().catch(err => {
  console.error('💥 Onverwachte fout:', err);
  process.exit(1);
});
