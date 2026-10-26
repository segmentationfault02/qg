// Réception des données Santé (via un Raccourci iPhone).
// Authentification par clé dédiée : seule son empreinte (sha256) est stockée côté serveur.
// Cette clé ne permet que d'écrire les données santé du jour, rien d'autre.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SB_URL, SRV, { auth: { persistSession: false } });
const out = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function safeEq(a: string, b: string) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
const zurichDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  const s = String(v).replace(/\s| | |'/g, "").replace(/[^\d.,-]/g, "");
  if (!s) return null;
  const n = parseFloat(s.includes(",") && !s.includes(".") ? s.replace(",", ".") : s.replace(/,/g, ""));
  return isFinite(n) ? n : null;
}
function minutes(v: unknown): number | null {
  // Durée de sommeil : accepte minutes, secondes ou heures, ou un texte « 7 h 12 min ».
  const t = String(v ?? "");
  const hm = /(\d+)\s*h(?:\s*(\d+))?/i.exec(t);
  if (hm) return +hm[1] * 60 + (+(hm[2] || 0));
  const n = num(v); if (n === null) return null;
  if (n > 1440) return Math.round(n / 60);
  if (n <= 24) return Math.round(n * 60);
  return Math.round(n);
}
function heure(v: unknown): string | null {
  const m = [...String(v ?? "").matchAll(/(\d{1,2})[:h.](\d{2})/g)].pop();
  if (!m) return null; const h = +m[1], mi = +m[2]; if (h > 23 || mi > 59) return null;
  return String(h).padStart(2, "0") + ":" + String(mi).padStart(2, "0");
}
const borne = (n: number | null, lo: number, hi: number) => (n === null || n < lo || n > hi ? null : Math.round(n * 10) / 10);

async function merge(owner: string, path: string, patch: Record<string, unknown>) {
  const { data } = await admin.from("docs").select("data").eq("path", path).maybeSingle();
  const cur = (data && data.data) || {};
  const nv = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null && v !== undefined)) };
  const { error } = await admin.from("docs").upsert({ path, col: "sante", data: nv, user_id: owner }, { onConflict: "path" });
  if (error) throw new Error("ecriture");
  return nv;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return out({ erreur: "methode" }, 405);
  const cle = req.headers.get("x-qg-cle") || "";
  const { data: h } = await admin.rpc("qg_cle", { p_nom: "sante_hash" });
  if (!h || !cle || !safeEq(await sha256(cle), String(h))) return out({ erreur: "cle_invalide" }, 401);
  const { data: own } = await admin.from("app_owner").select("user_id").maybeSingle();
  if (!own) return out({ erreur: "pas_de_proprietaire" }, 500);
  let p: Record<string, unknown> = {};
  try { const txt = await req.text(); if (txt.length > 20000) return out({ erreur: "trop_gros" }, 413); p = JSON.parse(txt); }
  catch { return out({ erreur: "json_invalide" }, 400); }

  const now = new Date();
  const aujourdHui = zurichDate(now), hier = zurichDate(new Date(now.getTime() - 86400000));
  const res: Record<string, unknown> = {};
  try {
    const nuit = {
      sommeilMin: borne(minutes(p.sommeil), 30, 960), coucher: heure(p.coucher), lever: heure(p.lever),
      profondMin: borne(minutes(p.profond), 0, 600), remMin: borne(minutes(p.rem), 0, 600), legerMin: borne(minutes(p.leger), 0, 900),
      fcRepos: borne(num(p.fcRepos), 25, 130), date: aujourdHui, recuNuit: now.toISOString(),
    };
    if (nuit.sommeilMin !== null || nuit.fcRepos !== null) res[aujourdHui] = await merge(own.user_id, "sante/" + aujourdHui, nuit);
    const kA = borne(num(p.kcalActives), 0, 8000), kR = borne(num(p.kcalRepos), 0, 5000);
    const jour = { kcalActives: kA, kcalRepos: kR, kcalTotal: kA !== null && kR !== null ? Math.round(kA + kR) : null, pas: borne(num(p.pas), 0, 100000), date: hier, recuJour: now.toISOString() };
    if (kA !== null || kR !== null || jour.pas !== null) res[hier] = await merge(own.user_id, "sante/" + hier, jour);
  } catch { return out({ erreur: "ecriture" }, 500); }
  return out({ ok: true, enregistre: Object.keys(res) });
});
