import OAuthProvider, { AuthorizationError } from '@cloudflare/workers-oauth-provider';
import schema from '../schema.sql';

/**
 * RunReader MCP connector: Claude reads the athlete's activity summaries.
 *
 * - `/mcp`: MCP over streamable HTTP, stateless JSON responses, OAuth-protected
 *   (claude.ai custom connectors log in once with ACCESS_CODE).
 * - `/sync`: RunReader pushes and deletes summaries, Bearer APP_TOKEN.
 *
 * Only summaries ever reach this Worker (see src/services/activitySummary.ts
 * in the app): no GPS, no per-second heart rate.
 */

interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  APP_TOKEN: string;
  ACCESS_CODE: string;
  OAUTH_PROVIDER: import('@cloudflare/workers-oauth-provider').OAuthHelpers;
}

interface Summary {
  syncKey: string;
  startTime: string;
  sportType: string;
  distanceMeters: number;
  movingSeconds: number;
  bestEfforts?: Record<string, number>;
  [field: string]: unknown;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Fingerprint of the current ACCESS_CODE, stored in each Claude login: when the
 * code changes, every connector logged in with the old one is cut off.
 */
async function codeId(env: Env): Promise<string> {
  const code = (env.ACCESS_CODE ?? '').normalize('NFC').trim();
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`runreader-login:${code}`));
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

/** Constant-time comparison, so a wrong token or code leaks nothing through timing */
async function sameSecret(given: string, expected: string): Promise<boolean> {
  // A secret pasted into `wrangler secret put` or a phone field easily carries a trailing newline
  expected = expected.trim();
  if (!expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all(
    [given.trim(), expected].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s)))
  );
  return crypto.subtle.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- sync ----

async function handleSync(request: Request, env: Env, path: string): Promise<Response> {
  const auth = request.headers.get('authorization') ?? '';
  if (!(await sameSecret(auth.replace(/^Bearer /, ''), env.APP_TOKEN ?? ''))) return json({ error: 'unauthorized' }, 401);

  if (request.method === 'PUT' && path === '/sync') {
    const text = await request.text();
    if (text.length > 2_000_000) return json({ error: 'payload too large' }, 413);
    const { activities } = JSON.parse(text) as { activities?: Summary[] };
    if (!Array.isArray(activities)) return json({ error: 'activities missing' }, 400);
    const valid = activities.filter(
      (a) =>
        typeof a?.syncKey === 'string' &&
        typeof a.sportType === 'string' &&
        !Number.isNaN(Date.parse(a.startTime))
    );
    const now = new Date().toISOString();
    const stmt = env.DB.prepare(
      `INSERT INTO activities (sync_key, start_time, sport_type, summary, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(sync_key) DO UPDATE SET start_time = excluded.start_time, sport_type = excluded.sport_type,
       summary = excluded.summary, updated_at = excluded.updated_at`
    );
    if (valid.length > 0) {
      await env.DB.batch(valid.map((a) => stmt.bind(a.syncKey, a.startTime, a.sportType, JSON.stringify(a), now)));
    }
    return json({ stored: valid.length, rejected: activities.length - valid.length });
  }
  if (request.method === 'GET' && path === '/sync/plans') {
    const today = new Date().toISOString().slice(0, 10);
    const { results } = await env.DB.prepare('SELECT id, date, workout FROM plans WHERE date >= ? ORDER BY date LIMIT 30')
      .bind(today)
      .all<{ id: string; date: string; workout: string }>();
    return json({ plans: (results ?? []).map((p) => ({ id: p.id, date: p.date, ...JSON.parse(p.workout) })) });
  }
  if (request.method === 'GET' && path === '/sync/advice') {
    const row = await env.DB.prepare('SELECT title, text, created_at FROM advice ORDER BY created_at DESC LIMIT 1').first();
    return json({ advice: row ?? null });
  }
  if (request.method === 'PUT' && path === '/sync/goal') {
    const text = await request.text();
    if (text.length > 4000) return json({ error: 'payload too large' }, 413);
    JSON.parse(text); // reject anything that is not JSON
    await env.DB.prepare(
      "INSERT INTO meta (key, value) VALUES ('goal', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
      .bind(text)
      .run();
    return json({ stored: 'goal' });
  }
  if (request.method === 'DELETE' && path === '/sync') {
    await env.DB.prepare('DELETE FROM activities').run();
    return json({ deleted: 'all' });
  }
  if (request.method === 'DELETE' && path.startsWith('/sync/')) {
    const key = decodeURIComponent(path.slice('/sync/'.length));
    await env.DB.prepare('DELETE FROM activities WHERE sync_key = ?').bind(key).run();
    return json({ deleted: key });
  }
  return json({ error: 'not found' }, 404);
}

// ----------------------------------------------------------- authorize ----

const page = (body: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RunReader</title><body style="font-family:system-ui;max-width:420px;margin:48px auto;padding:0 16px">${body}</body>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY' } }
  );

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  let oauthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    if (!error.redirectUri) return page(`<p>Richiesta non valida: ${escapeHtml(error.description)}</p>`, 400);
    const redirect = new URL(error.redirectUri);
    redirect.searchParams.set('error', error.code);
    redirect.searchParams.set('error_description', error.description);
    if (error.state) redirect.searchParams.set('state', error.state);
    if (error.issuer) redirect.searchParams.set('iss', error.issuer);
    return Response.redirect(redirect.href, 302);
  }

  // Anyone can register a client: show where the access goes, so a phishing link stands out
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  const host = new URL(oauthRequest.redirectUri).host;
  const isClaude = /(^|\.)claude\.(ai|com)$/.test(host);
  const form = (message = '') =>
    page(`<h2>Collega RunReader a Claude</h2>
<p>Claude potrà leggere i riepiloghi delle tue attività (niente GPS).</p>
<p>Richiesta da <b>${escapeHtml(client?.clientName ?? oauthRequest.clientId)}</b>, l'accesso va a <b>${escapeHtml(host)}</b>.</p>
${isClaude ? '' : '<p style="color:#c00"><b>Attenzione: questo non è un indirizzo di Claude.</b> Se non hai avviato tu il collegamento, chiudi la pagina.</p>'}
${message ? `<p style="color:#c00">${message}</p>` : ''}
<form method="post"><input name="code" type="password" autocomplete="current-password" placeholder="Codice di accesso"
 style="width:100%;padding:10px;font-size:16px" autofocus><button style="margin-top:12px;padding:10px 16px;font-size:16px">Autorizza</button></form>`);

  if (request.method !== 'POST') return form();
  // Trim and normalise both sides: a secret typed in a hidden terminal prompt or
  // piped from a file easily carries a trailing newline or a different Unicode form
  const clean = (v: string) => v.normalize('NFC').trim();
  const code = clean(String((await request.formData()).get('code') ?? ''));
  if (!(await sameSecret(code, clean(env.ACCESS_CODE ?? '')))) {
    // ponytail: a fixed delay slows guessing; a per-IP counter in KV if the URL ever leaks
    await new Promise((r) => setTimeout(r, 1500));
    return form('Codice errato.');
  }
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: 'owner',
    metadata: {},
    scope: oauthRequest.scope.filter((s) => s === 'mcp:read'),
    props: { code: await codeId(env) },
  });
  return Response.redirect(redirectTo, 302);
}

// ----------------------------------------------------------------- mcp ----

const TOOLS = [
  {
    name: 'list_activities',
    description:
      "Elenca le attività dell'atleta (più recenti prima): data, tipo, km, tempo, passo, FC media. Date in formato ISO (AAAA-MM-GG).",
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Data iniziale inclusa, es. 2026-08-01' },
        to: { type: 'string', description: 'Data finale inclusa, es. 2026-08-31' },
        type: { type: 'string', enum: ['running', 'walking', 'cycling', 'hiking', 'other'] },
      },
    },
  },
  {
    name: 'get_activity',
    description: "Riepilogo completo di un'attività: frazioni al km, tratti migliori, fonti dei dati.",
    inputSchema: {
      type: 'object',
      properties: { sync_key: { type: 'string', description: 'Da list_activities' } },
      required: ['sync_key'],
    },
  },
  {
    name: 'weekly_totals',
    description: 'Km, tempo in movimento e numero di corse per settimana (lunedì-domenica, solo corse).',
    inputSchema: { type: 'object', properties: { weeks: { type: 'number', description: 'Default 8, max 52' } } },
  },
  {
    name: 'personal_bests',
    description: 'Record personali per distanza (100 m … mezza maratona) misurati sul GPS, con la data.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'compare',
    description: 'Due o più attività affiancate, riepilogo completo di ciascuna.',
    inputSchema: {
      type: 'object',
      properties: { sync_keys: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 6 } },
      required: ['sync_keys'],
    },
  },
  {
    name: 'aerobic_trend',
    description:
      "Efficienza aerobica settimana per settimana sulle corse lente: metri percorsi per battito cardiaco, passo medio e FC media. Se i metri per battito salgono, l'atleta corre di più con lo stesso sforzo. Le corse con oltre il 15% del tempo sopra la soglia Z4 (calcolata dal profilo nell'app) sono escluse e contate in hardRunsExcluded: ripetute e corse forti abbassano il valore senza dire nulla sul fondo. Se quasi tutte le corse sono escluse, dillo invece di leggere un trend.",
    inputSchema: { type: 'object', properties: { weeks: { type: 'number', description: 'Default 12, max 52' } } },
  },
  {
    name: 'training_load',
    description:
      'Carico di allenamento: minuti di attività (tutti i tipi) negli ultimi 7 giorni contro la media settimanale delle ultime 4 settimane, con il loro rapporto (ACWR). Indicativo: 0.8-1.3 progressione sostenibile, oltre 1.5 aumento brusco.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'split_analysis',
    description:
      'Gestione del ritmo in una corsa: prima metà contro seconda metà (negative/positive split), variabilità del passo tra i km, km più veloce e più lento, FC per km.',
    inputSchema: {
      type: 'object',
      properties: { sync_key: { type: 'string', description: 'Da list_activities' } },
      required: ['sync_key'],
    },
  },
  {
    name: 'plan_workout',
    description:
      "Salva un allenamento pianificato: l'atleta lo vede nell'app RunReader. Usalo quando l'atleta chiede un piano o accetta una proposta.",
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'AAAA-MM-GG' },
        title: { type: 'string', description: 'Breve, es. "Fondo lento"' },
        description: { type: 'string', description: 'Cosa fare, in italiano, 1-3 frasi' },
        distance_km: { type: 'number' },
        target_pace: { type: 'string', description: 'es. "7:15/km"' },
        target_hr: { type: 'string', description: 'es. "140-150 bpm"' },
      },
      required: ['date', 'title', 'description'],
    },
  },
  {
    name: 'list_plans',
    description: 'Allenamenti pianificati in un intervallo di date (default: da oggi in poi).',
    inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } },
  },
  {
    name: 'get_goal',
    description:
      "Obiettivo dell'atleta impostato nell'app (es. 5 km, preparazione calcio), con dettaglio, data obiettivo e profilo dichiarato. Leggilo prima di proporre un piano.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'save_advice',
    description:
      "Salva un consiglio breve per l'atleta, mostrato nella scheda Coach dell'app. Usalo dopo aver analizzato lo storico o creato un piano: titolo di poche parole e 2-5 frasi concrete.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'es. "Settimana di scarico"' },
        text: { type: 'string', description: 'Il consiglio, 2-5 frasi' },
      },
      required: ['title', 'text'],
    },
  },
  {
    name: 'delete_plan',
    description: 'Elimina un allenamento pianificato (id da list_plans).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
];

const WEEK = 7 * 86_400_000;
const round = (v: number, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits;
const paceText = (secPerKm: number) =>
  `${Math.floor(secPerKm / 60)}:${String(Math.round(secPerKm % 60)).padStart(2, '0')}/km`;

interface Split {
  km: number;
  distanceMeters?: number;
  seconds: number;
  paceSeconds: number;
  avgHeartRate?: number;
}

const rows = async (env: Env, sql: string, ...args: unknown[]) =>
  ((await env.DB.prepare(sql).bind(...args).all<{ summary: string }>()).results ?? []).map(
    (r) => JSON.parse(r.summary) as Summary
  );

function mondayUtc(d: Date): number {
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return t - ((new Date(t).getUTCDay() + 6) % 7) * 86_400_000;
}

async function callTool(env: Env, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'list_activities': {
      const from = typeof args.from === 'string' ? args.from : '0000';
      const to = typeof args.to === 'string' ? `${args.to}T23:59:59Z` : '9999';
      const list = await rows(
        env,
        'SELECT summary FROM activities WHERE start_time >= ? AND start_time <= ? ORDER BY start_time DESC LIMIT 200',
        from,
        to
      );
      return list
        .filter((a) => !args.type || a.sportType === args.type)
        .map(({ splits: _s, bestEfforts: _b, sources: _src, ...brief }) => brief);
    }
    case 'get_activity': {
      const [a] = await rows(env, 'SELECT summary FROM activities WHERE sync_key = ?', String(args.sync_key));
      return a ?? { error: 'Attività non trovata' };
    }
    case 'weekly_totals': {
      const weeks = Math.min(52, Math.max(1, Number(args.weeks) || 8));
      const start = mondayUtc(new Date()) - (weeks - 1) * 7 * 86_400_000;
      const runs = await rows(
        env,
        "SELECT summary FROM activities WHERE sport_type = 'running' AND start_time >= ?",
        new Date(start).toISOString()
      );
      // ponytail: weeks cut at UTC midnight, an hour or two off Italian time; the app's own view is local
      const out = Array.from({ length: weeks }, (_, i) => ({
        weekStart: new Date(start + i * 7 * 86_400_000).toISOString().slice(0, 10),
        km: 0,
        movingMinutes: 0,
        runs: 0,
      }));
      for (const r of runs) {
        const w = out[Math.floor((mondayUtc(new Date(r.startTime)) - start) / (7 * 86_400_000))];
        if (!w) continue;
        w.km = Math.round((w.km + r.distanceMeters / 1000) * 100) / 100;
        w.movingMinutes += Math.round(r.movingSeconds / 60);
        w.runs += 1;
      }
      return out;
    }
    case 'personal_bests': {
      const runs = await rows(env, "SELECT summary FROM activities WHERE sport_type = 'running'");
      const best: Record<string, { seconds: number; date: string; syncKey: string }> = {};
      for (const r of runs) {
        for (const [key, seconds] of Object.entries(r.bestEfforts ?? {})) {
          if (!best[key] || seconds < best[key].seconds) {
            best[key] = { seconds, date: r.startTime.slice(0, 10), syncKey: r.syncKey };
          }
        }
      }
      return best;
    }
    case 'aerobic_trend': {
      const weeks = Math.min(52, Math.max(1, Number(args.weeks) || 12));
      const start = mondayUtc(new Date()) - (weeks - 1) * WEEK;
      const runs = (
        await rows(
          env,
          "SELECT summary FROM activities WHERE sport_type = 'running' AND start_time >= ?",
          new Date(start).toISOString()
        )
      ).filter((r) => typeof r.avgHeartRate === 'number' && r.movingSeconds > 0 && r.distanceMeters > 0);
      const out = Array.from({ length: weeks }, (_, i) => ({
        weekStart: new Date(start + i * WEEK).toISOString().slice(0, 10),
        runs: 0,
        hardRunsExcluded: 0,
        meters: 0,
        seconds: 0,
        beats: 0,
      }));
      for (const r of runs) {
        const w = out[Math.floor((mondayUtc(new Date(r.startTime)) - start) / WEEK)];
        if (!w) continue;
        // Same rule as the app's Coach card; summaries sent before the field existed count as easy
        if (typeof r.hardTimePercent === 'number' && r.hardTimePercent > 15) {
          w.hardRunsExcluded += 1;
          continue;
        }
        w.runs += 1;
        w.meters += r.distanceMeters;
        w.seconds += r.movingSeconds;
        w.beats += (r.avgHeartRate as number) * (r.movingSeconds / 60);
      }
      return out.map((w) =>
        w.runs === 0
          ? { weekStart: w.weekStart, runs: 0, hardRunsExcluded: w.hardRunsExcluded }
          : {
              weekStart: w.weekStart,
              runs: w.runs,
              hardRunsExcluded: w.hardRunsExcluded,
              metersPerBeat: round(w.meters / w.beats),
              avgPace: paceText(w.seconds / (w.meters / 1000)),
              avgHeartRate: Math.round(w.beats / (w.seconds / 60)),
            }
      );
    }
    case 'training_load': {
      const now = Date.now();
      const recent = await rows(
        env,
        'SELECT summary FROM activities WHERE start_time >= ?',
        new Date(now - 28 * 86_400_000).toISOString()
      );
      const minutes = (from: number) =>
        recent.filter((r) => Date.parse(r.startTime) >= from).reduce((sum, r) => sum + r.movingSeconds / 60, 0);
      const acute = minutes(now - 7 * 86_400_000);
      const chronic = minutes(now - 28 * 86_400_000) / 4;
      const last = recent.map((r) => Date.parse(r.startTime)).sort((a, b) => b - a)[0];
      return {
        last7DaysMinutes: Math.round(acute),
        weeklyAverage28DaysMinutes: Math.round(chronic),
        acwr: chronic > 0 ? round(acute / chronic) : null,
        activitiesLast28Days: recent.length,
        daysSinceLastActivity: last ? Math.floor((now - last) / 86_400_000) : null,
        note: 'Carico = minuti in movimento, senza intensità: la FC max non è sul server. Con meno di 4 settimane di storico il rapporto è sovrastimato.',
      };
    }
    case 'split_analysis': {
      const [a] = await rows(env, 'SELECT summary FROM activities WHERE sync_key = ?', String(args.sync_key));
      if (!a) return { error: 'Attività non trovata' };
      // A partial last km (under 950 m) has a pace that is not comparable
      const splits = ((a.splits as Split[]) ?? []).filter(
        (s) => (s.distanceMeters ?? 1000) >= 950 && s.paceSeconds > 0
      );
      if (splits.length < 2) return { error: 'Servono almeno 2 km completi per analizzare il ritmo.' };
      const half = Math.floor(splits.length / 2);
      const avg = (list: Split[]) => list.reduce((s, x) => s + x.paceSeconds, 0) / list.length;
      const first = avg(splits.slice(0, half));
      const second = avg(splits.slice(splits.length - half));
      const mean = avg(splits);
      const sd = Math.sqrt(splits.reduce((s, x) => s + (x.paceSeconds - mean) ** 2, 0) / splits.length);
      const byPace = [...splits].sort((x, y) => x.paceSeconds - y.paceSeconds);
      return {
        fullKm: splits.length,
        firstHalfPace: paceText(first),
        secondHalfPace: paceText(second),
        splitType: Math.abs(second - first) < 3 ? 'even' : second < first ? 'negative' : 'positive',
        paceVariationPercent: round((sd / mean) * 100, 1),
        fastestKm: { km: byPace[0].km, pace: paceText(byPace[0].paceSeconds) },
        slowestKm: { km: byPace[byPace.length - 1].km, pace: paceText(byPace[byPace.length - 1].paceSeconds) },
        heartRateByKm: splits.map((s) => s.avgHeartRate ?? null),
      };
    }
    case 'plan_workout': {
      const date = String(args.date ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date deve essere AAAA-MM-GG');
      const workout = {
        title: String(args.title ?? '').slice(0, 80),
        description: String(args.description ?? '').slice(0, 600),
        distanceKm: typeof args.distance_km === 'number' ? args.distance_km : undefined,
        targetPace: typeof args.target_pace === 'string' ? args.target_pace.slice(0, 20) : undefined,
        targetHr: typeof args.target_hr === 'string' ? args.target_hr.slice(0, 20) : undefined,
      };
      const id = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO plans (id, date, workout, created_at) VALUES (?, ?, ?, ?)')
        .bind(id, date, JSON.stringify(workout), new Date().toISOString())
        .run();
      return { saved: true, id, date, ...workout };
    }
    case 'list_plans': {
      const from = typeof args.from === 'string' ? args.from : new Date().toISOString().slice(0, 10);
      const to = typeof args.to === 'string' ? args.to : '9999-12-31';
      const { results } = await env.DB.prepare(
        'SELECT id, date, workout FROM plans WHERE date >= ? AND date <= ? ORDER BY date'
      )
        .bind(from, to)
        .all<{ id: string; date: string; workout: string }>();
      return (results ?? []).map((p) => ({ id: p.id, date: p.date, ...JSON.parse(p.workout) }));
    }
    case 'get_goal': {
      const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'goal'").first<{ value: string }>();
      return row ? JSON.parse(row.value) : { goal: null, note: "L'atleta non ha ancora scelto un obiettivo nell'app." };
    }
    case 'save_advice': {
      const title = String(args.title ?? '').slice(0, 80);
      const text = String(args.text ?? '').slice(0, 1200);
      if (!title || !text) throw new Error('title e text sono obbligatori');
      await env.DB.prepare('INSERT INTO advice (id, title, text, created_at) VALUES (?, ?, ?, ?)')
        .bind(crypto.randomUUID(), title, text, new Date().toISOString())
        .run();
      return { saved: true, title };
    }
    case 'delete_plan': {
      await env.DB.prepare('DELETE FROM plans WHERE id = ?').bind(String(args.id)).run();
      return { deleted: String(args.id) };
    }
    case 'compare': {
      const keys = (Array.isArray(args.sync_keys) ? args.sync_keys : []).map(String).slice(0, 6);
      if (keys.length === 0) return [];
      return rows(
        env,
        `SELECT summary FROM activities WHERE sync_key IN (${keys.map(() => '?').join(',')}) ORDER BY start_time`,
        ...keys
      );
    }
    default:
      throw new Error(`Strumento sconosciuto: ${name}`);
  }
}

interface RpcMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

async function rpc(env: Env, msg: RpcMessage): Promise<object | null> {
  if (msg.id === undefined) return null; // notification: nothing to answer
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return ok({
        protocolVersion: (msg.params?.protocolVersion as string) ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'runreader', version: '1.0.0' },
        instructions:
          'Riepiloghi delle attività di un runner registrate con RunReader. Usa solo questi numeri: se un dato manca, dillo invece di stimarlo.',
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      try {
        const data = await callTool(env, name, (msg.params?.arguments as Record<string, unknown>) ?? {});
        return ok({ content: [{ type: 'text', text: JSON.stringify(data) }] });
      } catch (e) {
        return ok({ content: [{ type: 'text', text: (e as Error).message }], isError: true });
      }
    }
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Metodo non supportato: ${msg.method}` } };
  }
}

const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Logged in with an older ACCESS_CODE: revoke the whole login, so the refresh
    // token dies too and Claude has to ask for the current code
    const { props, auth } = ctx as ExecutionContext<{ code?: string }> & { auth: { token: string } };
    if (props?.code !== (await codeId(env))) {
      const [userId, grantId] = auth.token.split(':'); // token format: {userId}:{grantId}:{secret}
      await env.OAUTH_PROVIDER.revokeGrant(grantId, userId);
      return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer error="invalid_token"' } });
    }
    // Stateless server: no SSE stream to open, no session to close
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
    let body: RpcMessage | RpcMessage[];
    try {
      body = await request.json();
    } catch {
      return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
    }
    const replies = (await Promise.all((Array.isArray(body) ? body : [body]).map((m) => rpc(env, m)))).filter(
      (r) => r !== null
    );
    if (replies.length === 0) return new Response(null, { status: 202 });
    return json(Array.isArray(body) ? replies : replies[0]);
  },
};

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/authorize') return handleAuthorize(request, env);
    if (path === '/sync' || path.startsWith('/sync/')) return handleSync(request, env, path);
    // Landing page: the first thing a phone user sees after "Deploy to Cloudflare"
    if (path === '/' && request.method === 'GET') {
      return page(`<h2>RunReader: server pronto ✓</h2>
<p>Torna in RunReader (Profilo › Claude) e incolla questo indirizzo:</p>
<p style="font-family:monospace;font-size:16px;word-break:break-all;background:#eee;padding:10px">${escapeHtml(url.origin)}</p>`);
    }
    return new Response('RunReader MCP', { status: 404 });
  },
};

// The resource URL depends on the workers.dev subdomain: built from the first request's origin
let provider: OAuthProvider<Env> | null = null;

/**
 * Creates the tables on the first request of each isolate, so a server made
 * with "Deploy to Cloudflare" from a phone needs no `wrangler d1 execute`.
 * Every statement is IF NOT EXISTS: rerunning it is a no-op.
 */
let schemaReady: Promise<unknown> | null = null;
const ensureSchema = (env: Env) =>
  (schemaReady ??= env.DB.batch(
    schema
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((sql) => sql.trim())
      .filter(Boolean)
      .map((sql) => env.DB.prepare(sql))
  ).catch((e) => {
    schemaReady = null; // retry on the next request
    throw e;
  }));

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    await ensureSchema(env);
    const origin = new URL(request.url).origin;
    provider ??= new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: mcpHandler,
      defaultHandler,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      scopesSupported: ['mcp:read'],
      resourceMetadata: {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ['mcp:read'],
      },
      clientIdMetadataDocumentEnabled: true,
    });
    return provider.fetch(request, env, ctx);
  },
};
