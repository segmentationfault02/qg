// Fonction serveur du QG : relais vers Hevy et OJP (transports CH).
// Les clés restent côté serveur (table private.cles), jamais dans le navigateur.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ORIGINS = ["https://segmentationfault02.github.io"];

function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });

const keyCache: Record<string, string> = {};
async function cle(nom: string): Promise<string> {
  if (keyCache[nom]) return keyCache[nom];
  const admin = createClient(SB_URL, SRV, { auth: { persistSession: false } });
  const { data, error } = await admin.rpc("qg_cle", { p_nom: nom });
  if (error || !data) throw new Error("cle_absente");
  keyCache[nom] = data as string;
  return keyCache[nom];
}

function jwtPayload(token: string): Record<string, unknown> {
  try {
    const p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(p + "===".slice((p.length + 3) % 4)));
  } catch { return {}; }
}

/* ---------- XML minimal ---------- */
type XNode = { name: string; children: XNode[]; text: string };
function parseXml(xml: string): XNode {
  const root: XNode = { name: "#", children: [], text: "" };
  const stack = [root];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>|([^<]+)/g;
  xml = xml.replace(/<\?[^>]*\?>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[5] !== undefined) { if (m[5].trim()) stack[stack.length - 1].text += m[5]; continue; }
    const name = m[2].replace(/^.*:/, "");
    if (m[1]) { if (stack.length > 1) stack.pop(); }
    else { const n: XNode = { name, children: [], text: "" }; stack[stack.length - 1].children.push(n); if (!m[4]) stack.push(n); }
  }
  return root;
}
const ents: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const dec = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ents[e]);
const kids = (n: XNode | undefined, name: string) => (n ? n.children.filter((c) => c.name === name) : []);
const kid = (n: XNode | undefined, name: string) => kids(n, name)[0];
const at = (n: XNode | undefined, ...p: string[]) => p.reduce<XNode | undefined>((a, x) => (a ? kid(a, x) : undefined), n);
const txt = (n: XNode | undefined) => (n ? dec(n.text.trim()) : "");
function findAll(n: XNode, name: string, out: XNode[] = []): XNode[] {
  for (const c of n.children) { if (c.name === name) out.push(c); else findAll(c, name, out); }
  return out;
}
const isoMin = (d: string) => { const m = /PT(?:(\d+)H)?(?:(\d+)M)?/.exec(d || ""); return m ? (+(m[1] || 0)) * 60 + (+(m[2] || 0)) : 0; };

/* ---------- OJP ---------- */
const xmlEsc = (s: string) => String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]!));
async function ojp(inner: string): Promise<XNode> {
  const now = new Date().toISOString();
  const body = `<?xml version="1.0" encoding="UTF-8"?><OJP xmlns="http://www.vdv.de/ojp" xmlns:siri="http://www.siri.org.uk/siri" version="2.0"><OJPRequest><siri:ServiceRequest><siri:ServiceRequestContext><siri:Language>fr</siri:Language></siri:ServiceRequestContext><siri:RequestTimestamp>${now}</siri:RequestTimestamp><siri:RequestorRef>QG_prod</siri:RequestorRef>${inner.replace(/__NOW__/g, now)}</siri:ServiceRequest></OJPRequest></OJP>`;
  const r = await fetch("https://api.opentransportdata.swiss/ojp20", {
    method: "POST",
    headers: { "Authorization": "Bearer " + (await cle("ojp")), "Content-Type": "application/xml", "Accept": "application/xml" },
    body,
  });
  if (!r.ok) throw new Error("ojp_" + r.status);
  return parseXml(await r.text());
}
async function stops(q: string) {
  const x = await ojp(`<OJPLocationInformationRequest><siri:RequestTimestamp>__NOW__</siri:RequestTimestamp><InitialInput><Name>${xmlEsc(q)}</Name></InitialInput><Restrictions><Type>stop</Type><NumberOfResults>8</NumberOfResults></Restrictions></OJPLocationInformationRequest>`);
  return findAll(x, "PlaceResult").map((pr) => {
    const sp = at(pr, "Place", "StopPlace");
    return { ref: txt(kid(sp, "StopPlaceRef")), nom: txt(at(sp, "StopPlaceName", "Text")) || txt(at(pr, "Place", "Name", "Text")) };
  }).filter((s) => s.ref);
}
function point(n: XNode | undefined, kind: "ServiceDeparture" | "ServiceArrival") {
  const s = kid(n, kind);
  return {
    nom: txt(at(n, "StopPointName", "Text")),
    voie: txt(at(n, "EstimatedQuay", "Text")) || txt(at(n, "PlannedQuay", "Text")),
    voiePrevue: txt(at(n, "PlannedQuay", "Text")),
    prevu: txt(kid(s, "TimetabledTime")),
    estime: txt(kid(s, "EstimatedTime")) || null,
  };
}
async function trip(p: { from: { ref: string; nom: string }; to: { ref: string; nom: string }; time: string; arrive?: boolean; n?: number }) {
  const t = xmlEsc(new Date(p.time).toISOString());
  const place = (s: { ref: string; nom: string }) => `<PlaceRef><StopPlaceRef>${xmlEsc(s.ref)}</StopPlaceRef><Name><Text>${xmlEsc(s.nom || s.ref)}</Text></Name></PlaceRef>`;
  const x = await ojp(`<OJPTripRequest><siri:RequestTimestamp>__NOW__</siri:RequestTimestamp><Origin>${place(p.from)}${p.arrive ? "" : `<DepArrTime>${t}</DepArrTime>`}</Origin><Destination>${place(p.to)}${p.arrive ? `<DepArrTime>${t}</DepArrTime>` : ""}</Destination><Params><NumberOfResults>${Math.min(8, p.n || 6)}</NumberOfResults><IncludeIntermediateStops>false</IncludeIntermediateStops><UseRealtimeData>explanatory</UseRealtimeData></Params></OJPTripRequest>`);
  return findAll(x, "Trip").map((tr) => {
    const legs = kids(tr, "Leg").map((lg) => {
      const tl = kid(lg, "TimedLeg");
      if (tl) {
        const sv = kid(tl, "Service");
        const cat = txt(at(sv, "ProductCategory", "ShortName", "Text")) || txt(at(sv, "Mode", "ShortName", "Text"));
        return {
          type: "pt",
          mode: txt(at(sv, "Mode", "PtMode")),
          cat,
          ligne: txt(at(sv, "PublishedServiceName", "Text")) || txt(kid(sv, "PublicCode")),
          direction: txt(at(sv, "DestinationText", "Text")),
          annule: txt(kid(sv, "Cancelled")) === "true",
          dep: point(kid(tl, "LegBoard"), "ServiceDeparture"),
          arr: point(kid(tl, "LegAlight"), "ServiceArrival"),
        };
      }
      const other = kid(lg, "TransferLeg") || kid(lg, "ContinuousLeg");
      return { type: "marche", minutes: isoMin(txt(kid(lg, "Duration")) || txt(kid(other, "Duration"))), de: txt(at(other, "LegStart", "Name", "Text")), vers: txt(at(other, "LegEnd", "Name", "Text")) };
    });
    return { depart: txt(kid(tr, "StartTime")), arrivee: txt(kid(tr, "EndTime")), minutes: isoMin(txt(kid(tr, "Duration"))), changements: +txt(kid(tr, "Transfers")) || 0, legs };
  });
}

/* ---------- Hevy ---------- */
async function hevy(path: string) {
  const r = await fetch("https://api.hevyapp.com" + path, { headers: { "api-key": await cle("hevy"), "accept": "application/json" } });
  if (!r.ok) throw new Error("hevy_" + r.status);
  return r.json();
}
async function hevyToday(p: { dossier: string; seance: string }) {
  const f = await hevy("/v1/routine_folders?page=1&pageSize=10");
  const folder = (f.routine_folders || []).find((x: { title: string }) => x.title.trim().toLowerCase() === String(p.dossier).trim().toLowerCase());
  if (!folder) return { erreur: "dossier_introuvable", dossiers: (f.routine_folders || []).map((x: { title: string }) => x.title) };
  const all: any[] = [];
  for (let page = 1; page <= 6; page++) {
    const r = await hevy(`/v1/routines?page=${page}&pageSize=10`);
    all.push(...(r.routines || []));
    if (page >= (r.page_count || 1)) break;
  }
  const want = String(p.seance).toUpperCase();
  const inFolder = all.filter((r) => r.folder_id === folder.id);
  const routine = inFolder.find((r) => String(r.title).toUpperCase().includes(want));
  if (!routine) return { erreur: "seance_introuvable", seances: inFolder.map((r) => r.title) };
  let derniere: any = null;
  try {
    const w = await hevy("/v1/workouts?page=1&pageSize=10");
    derniere = (w.workouts || []).find((x: any) => x.routine_id === routine.id) || null;
  } catch { /* historique facultatif */ }
  const lastByEx: Record<string, any[]> = {};
  if (derniere) for (const e of derniere.exercises || []) lastByEx[e.exercise_template_id] = e.sets || [];
  return {
    titre: routine.title,
    derniereFois: derniere ? derniere.start_time : null,
    exercices: (routine.exercises || []).map((e: any) => ({
      titre: e.title,
      repos: e.rest_seconds,
      note: e.notes || "",
      series: (e.sets || []).map((s: any) => ({ type: s.type, kg: s.weight_kg, reps: s.reps, plage: s.rep_range || null })),
      dernier: (lastByEx[e.exercise_template_id] || []).filter((s: any) => s.type !== "warmup").map((s: any) => ({ kg: s.weight_kg, reps: s.reps })),
    })),
  };
}

async function hevyDurees() {
  const types = ["pull", "legs", "push", "lower", "upper"];
  const parType: Record<string, number[]> = {};
  for (let page = 1; page <= 3; page++) {
    const r = await hevy(`/v1/workouts?page=${page}&pageSize=10`);
    for (const w of r.workouts || []) {
      const titre = String(w.title || "").toLowerCase();
      const t = types.find((x) => titre.includes(x));
      if (!t || !w.start_time || !w.end_time) continue;
      const min = Math.round((new Date(w.end_time).getTime() - new Date(w.start_time).getTime()) / 60000);
      if (min < 20 || min > 240) continue;
      (parType[t] = parType[t] || []).push(min);
    }
    if (page >= (r.page_count || 1)) break;
  }
  const durees: Record<string, number> = {};
  for (const t of types) { const L = (parType[t] || []).slice(0, 5); if (L.length) durees[t] = Math.round(L.reduce((a, b) => a + b, 0) / L.length); }
  return { durees, nb: Object.fromEntries(types.map((t) => [t, Math.min(5, (parType[t] || []).length)])) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { erreur: "methode" }, 405);
  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (jwtPayload(token).aal !== "aal2") return json(req, { erreur: "double_authentification_requise" }, 401);
  const userClient = createClient(SB_URL, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: u } = await userClient.auth.getUser(token);
  if (!u || !u.user) return json(req, { erreur: "non_connecte" }, 401);
  const { data: owner } = await userClient.from("app_owner").select("user_id").maybeSingle();
  if (!owner || owner.user_id !== u.user.id) return json(req, { erreur: "acces_refuse" }, 403);

  let p: any = {};
  try { p = await req.json(); } catch { return json(req, { erreur: "requete_invalide" }, 400); }
  try {
    switch (p.action) {
      case "arrets": return json(req, { arrets: await stops(String(p.q || "").slice(0, 80)) });
      case "trajet": return json(req, { trajets: await trip(p) });
      case "hevy_seance": return json(req, await hevyToday(p));
      case "hevy_durees": return json(req, await hevyDurees());
      default: return json(req, { erreur: "action_inconnue" }, 400);
    }
  } catch (e) {
    return json(req, { erreur: String((e as Error).message || e) }, 502);
  }
});
