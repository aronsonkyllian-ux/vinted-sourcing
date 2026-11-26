/* Sourcing Vinted — application locale, pas de clé d'API, rien n'est envoyé. */
const TZ = "Europe/Zurich";
const STOCK_KEY = "sourcing-stock-v1";
const SEEN_KEY = "sourcing-alert-seen-v1";
const WEEKEND_NOTIF_KEY = "sourcing-weekend-notif";
const SEEN_CACHE_PATH = "./__seen_alerts__";
const euro = n => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(Number(n) || 0);
const eur0 = n => euro(n).replace(/\s/g, "\u00a0");
const fmtDate = iso => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short", timeZone: TZ }).format(d) + " (heure de Zurich)";
};
const todayISO = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const uid = () => "s" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let DATA = null;
let photoFile = null;
let stockFilter = "all";
let flagMode = "net"; // net | third | all
let deferredPrompt = null;

function cfg() {
  return DATA?.assumptions || {
    packaging_per_item: 0.4, urssaf_rate: 0.134, defect_unsold_rate: 0.1, max_cost_ratio: 0.3334, grade_b_factor: 0.7
  };
}

function netMargin(resale, cost, { lot = false } = {}) {
  const c = cfg();
  const packing = c.packaging_per_item;
  const urssafR = c.urssaf_rate;
  const defect = lot ? c.defect_unsold_rate : 0;
  const effective = defect < 1 ? cost / (1 - defect) : cost;
  const charges = resale * urssafR;
  const net = resale - effective - packing - charges;
  return {
    resale: round2(resale),
    cost_per_piece: round2(cost),
    effective_cost: round2(effective),
    packaging: round2(packing),
    urssaf: round2(charges),
    net: round2(net),
    net_pct: resale ? Math.round((net / resale) * 1000) / 10 : 0,
    cost_ratio: resale ? Math.round((cost / resale) * 1000) / 1000 : 9,
    rule_one_third_ok: cost <= resale * c.max_cost_ratio,
    defect
  };
}
const round2 = n => Math.round(Number(n) * 100) / 100;

function findBrand(name) {
  const brands = DATA?.brands || [];
  const q = (name || "").trim().toLowerCase();
  if (!q) return null;
  return brands.find(b => b.brand.toLowerCase() === q)
    || brands.find(b => (b.keys || []).some(k => k && q.includes(k)))
    || brands.find(b => b.brand.toLowerCase().includes(q) || q.includes(b.brand.toLowerCase()));
}

function resaleFor(brandName, type, cond) {
  const b = findBrand(brandName);
  const factor = Number(cond) || 1;
  let base, basis;
  if (!b || /éviter/i.test(b.brand)) {
    if (!b) {
      base = 15;
      basis = "estimation prudente sans marque précise (15 €)";
    } else {
      base = type === "high" ? b.high : type === "low" ? b.low : b.median;
      basis = "médiane / fourchette Revendor — marque peu rentable";
    }
  } else if (type === "high") {
    base = b.median; basis = "médiane Revendor (veste / doudoune : pas de statistique réelle par catégorie)";
  } else if (type === "low") {
    base = b.low; basis = "bas de fourchette Revendor (t-shirt / short / accessoire)";
  } else {
    base = b.median; basis = "médiane Revendor";
  }
  if (factor < 1) {
    base *= (cfg().grade_b_factor || 0.7);
    basis += ", −30 % grade B/C (estimation)";
  }
  return { resale: round2(base), basis, brand: b };
}

/* ---------- tabs ---------- */
function showTab(id) {
  $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === id));
  $$("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.t === id));
  if (location.hash.replace("#", "") !== id) history.replaceState(null, "", "#" + id);
  window.scrollTo(0, 0);
}

/* ---------- brands ---------- */
function renderBrands() {
  const brands = (DATA.brands || []).slice().sort((a, b) => b.sales - a.sales);
  const max = Math.max(...brands.map(b => b.sales), 1);
  $("#brands").innerHTML = brands.map(b => {
    const avoid = /éviter/i.test(b.brand);
    return `<article class="item brand-item ${avoid ? "avoid" : ""}">
      <div class="t">${esc(b.brand)}</div>
      <div class="v">${eur0(b.median)}</div>
      <div class="s">${b.sales.toLocaleString("fr-FR")} ventes · fourchette ${eur0(b.low)} – ${eur0(b.high)}</div>
      <div class="w">médiane</div>
      <div class="track"><div class="fill" style="width:${Math.max(6, (b.sales / max) * 100)}%"></div></div>
    </article>`;
  }).join("");
}

/* ---------- offers ---------- */
function populateFilters() {
  const offs = DATA.offers || [];
  const sources = [...new Set(offs.map(o => o.source))].sort((a, b) => a.localeCompare(b, "fr"));
  const brands = [...new Set(offs.flatMap(o => o.brands))].sort((a, b) => a.localeCompare(b, "fr"));
  const src = $("#fSource"), br = $("#fBrand");
  src.innerHTML = `<option value="">Toutes</option>` + sources.map(s => `<option>${esc(s)}</option>`).join("");
  br.innerHTML = `<option value="">Toutes</option>` + brands.map(s => `<option>${esc(s)}</option>`).join("");
}

function genderMix() {
  const g = DATA?.gender_mix || {};
  const femme = Number(g.femme);
  return { femme: femme > 0 && femme < 1 ? femme : 0.8, homme: 1 - (femme > 0 && femme < 1 ? femme : 0.8) };
}

function minNet() {
  const q = DATA?.offer_quality || DATA?.other_brand_keep || {};
  const n = Number(q.min_net_per_piece);
  return Number.isFinite(n) ? n : 5;
}

function prioritySort(a, b) {
  const pa = a.priority_brand ? 0 : 1;
  const pb = b.priority_brand ? 0 : 1;
  if (pa !== pb) return pa - pb;
  const na = b.margin.net - a.margin.net;
  if (na !== 0) return na;
  const ra = (a.margin.cost_ratio || 9) - (b.margin.cost_ratio || 9);
  if (ra !== 0) return ra;
  return (b.score - a.score) || ((b.brand_sales || 0) - (a.brand_sales || 0));
}

function balanceGender(list) {
  const { femme: femmeShare, homme: hommeShare } = genderMix();
  const f = list.filter(o => o.gender === "femme");
  const h = list.filter(o => o.gender === "homme");
  const m = list.filter(o => o.gender !== "femme" && o.gender !== "homme");
  if (!h.length) return f.length ? f.concat(m) : m;
  const takeF = f.length;
  const allH = h;
  const takeH = takeF ? Math.min(h.length, Math.max(0, Math.round(takeF * hommeShare / femmeShare))) : h.length;
  const F = f.slice(0, takeF), H = h.slice(0, takeH);
  const stepF = Math.max(1, Math.round(femmeShare / Math.max(hommeShare, 0.01)));
  const out = [];
  let i = 0, j = 0;
  while (i < F.length || j < H.length) {
    for (let k = 0; k < stepF && i < F.length; k++) out.push(F[i++]);
    if (j < H.length) out.push(H[j++]);
  }
  const restH = allH.filter(o => !H.includes(o));
  if (!m.length) return out.concat(restH);
  const mixteRe = /homme\s*(et|-|\/|,)\s*femme|femme\s*(et|-|\/|,)\s*homme|unisexe|unisex|\bmixte\b|homme\s*-\s*femme|femme\s*-\s*homme/i;
  const explicit = m.filter(o => mixteRe.test(o.title || ""));
  const other = m.filter(o => !mixteRe.test(o.title || ""));
  const cap = Math.max(explicit.length, Math.round(0.25 * Math.max(1, out.length)));
  const M = explicit.concat(other).slice(0, cap);
  const mixed = [];
  const stride = Math.max(1, Math.floor(out.length / Math.max(1, M.length)));
  let mi = 0;
  out.forEach((o, k) => {
    mixed.push(o);
    if (mi < M.length && (k + 1) % stride === 0) mixed.push(M[mi++]);
  });
  const restM = m.filter(o => !M.includes(o));
  return mixed.concat(M.slice(mi), restH, restM);
}

function filteredOffers() {
  const budget = Number($("#fBudget").value);
  const src = $("#fSource").value;
  const brand = $("#fBrand").value;
  const gender = $("#fGender") ? $("#fGender").value : "";
  const sort = $("#fSort").value;
  let list = (DATA.offers || []).slice();
  if (budget) list = list.filter(o => o.total_price <= budget);
  if (src) list = list.filter(o => o.source === src);
  if (brand) list = list.filter(o => o.brands.includes(brand));
  if (gender === "femme") list = list.filter(o => o.gender === "femme" || o.gender === "mixte");
  if (gender === "homme") list = list.filter(o => o.gender === "homme" || o.gender === "mixte");
  const q = DATA?.offer_quality || {};
  const minN = Number.isFinite(Number(q.min_net_per_piece)) ? Number(q.min_net_per_piece) : minNet();
  const minC = Number.isFinite(Number(q.min_coefficient)) ? Number(q.min_coefficient) : 2;
  list = list.filter(o => {
    const m = o.margin || {};
    const coeff = m.coefficient || (m.cost_per_piece ? m.resale / m.cost_per_piece : 0);
    return m.net >= minN && coeff >= minC;
  });
  if (flagMode === "season") list = list.filter(o => o.season === "in");
  if (flagMode === "net") list = list.filter(o => o.margin.net > 0);
  if (flagMode === "top" || flagMode === "third") list = list.filter(o => o.quality_level === "top" || o.margin.rule_one_third_ok);
  list.sort((a, b) => {
    if (sort === "net") return b.margin.net - a.margin.net;
    if (sort === "total") return a.total_price - b.total_price;
    if (sort === "sales") return (b.brand_sales || 0) - (a.brand_sales || 0);
    const sa = {in:0, mid:1, off:2}[a.season] ?? 1;
    const sb = {in:0, mid:1, off:2}[b.season] ?? 1;
    if (sa !== sb) return sa - sb;
    return prioritySort(a, b);
  });
  if (!gender) list = balanceGender(list);
  return list;
}

function renderOffers() {
  const list = filteredOffers();
  const nf = list.filter(o => o.gender === "femme").length;
  const nh = list.filter(o => o.gender === "homme").length;
  const nm = list.filter(o => o.gender === "mixte").length;
  const nNew = list.filter(o => o.is_new).length;
  $("#offCount").textContent = list.length + " offre" + (list.length > 1 ? "s" : "")
    + (list.length ? ` · ${nf} femme / ${nh} homme / ${nm} mixte` : "")
    + (nNew ? ` · ${nNew} nouvelle${nNew > 1 ? "s" : ""}` : "");
  if (!list.length) {
    $("#offers").innerHTML = `<div class="card"><p class="note" style="margin:0">Aucune offre avec ces filtres. Avec 100 €, élargis à « Tous les prix » pour voir les lots, ou garde le cap friperie (onglet Plan).</p></div>`;
    return;
  }
  $("#offers").innerHTML = list.map((o, i) => {
    const m = o.margin;
    const netCls = m.net > 0 ? "pos" : "neg";
    const g = o.gender === "femme" ? "Femme" : o.gender === "homme" ? "Homme" : "Mixte";
    const gCls = o.gender === "femme" ? "femme" : o.gender === "homme" ? "homme" : "mixte";
    const tags = [
      `<span class="tag ${gCls}">${g}</span>`,
      o.is_new ? `<span class="tag new">Nouveau</span>` : "",
      o.season === "in" ? `<span class="tag saison">de saison</span>` : (o.season === "off" ? `<span class="tag off">hors saison</span>` : ""),
      o.quality_level ? `<span class="tag ${o.quality_level}">${o.quality_level}</span>` : "",
      `<span class="tag">score ${o.score}</span>`,
      o.margin.rule_one_third_ok ? `<span class="tag ok">1/3 ok</span>` : "",
      o.priority_brand ? "" : `<span class="tag">hors liste</span>`,
      o.margin_caution ? `<span class="tag warn">à vérifier</span>` : "",
      o.pieces_estimated ? `<span class="tag warn">pièces estimées</span>` : "",
      /ESTIMATION/i.test(o.shipping_note || "") && o.shipping ? `<span class="tag warn">port estimé</span>` : ""
    ].join("");
    return `<article class="item tap" data-i="${i}" role="button" tabindex="0">
      <div class="t">${esc(o.title)}</div>
      <div class="v ${netCls}">${eur0(m.net)}<span class="muted"> / pc</span></div>
      <div class="s">${esc(o.source)} · ${eur0(o.total_price)} · ${o.pieces} pc${o.pieces > 1 ? "s" : ""} · ${esc((o.brands || []).join(", "))}</div>
      <div class="w">revente ${eur0(m.resale)}</div>
      <div class="full">${tags}</div>
    </article>`;
  }).join("");
  $$("#offers .item").forEach((el, i) => {
    const open = () => openOffer(list[i]);
    el.addEventListener("click", open);
    el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });
}

function openOffer(o) {
  const m = o.margin;
  const body = $("#sheetBody");
  body.innerHTML = `
    <h3>${esc(o.title)}</h3>
    <p class="muted">${esc(o.source)} · ${esc((o.brands || []).join(", "))} · ${esc(o.gender === "femme" ? "Femme" : o.gender === "homme" ? "Homme" : "Mixte")}${o.is_new ? " · Nouveau" : ""}</p>
    <div class="kv" style="margin:14px 0">
      <span>Prix + port</span><b>${eur0(o.total_price)}</b>
      <span>dont port</span><b>${eur0(o.shipping)} ${o.shipping_note ? "· " + esc(o.shipping_note) : ""}</b>
      <span>Pièces</span><b>${o.pieces}${o.pieces_estimated ? " (estimé)" : ""}</b>
      <span>Coût / pièce</span><b>${eur0(m.cost_per_piece)}</b>
      <span>Revente attendue</span><b>${eur0(m.resale)}</b>
      <span>Base du prix</span><b>${esc(o.resale_basis)}</b>
      <span>Emballage</span><b>${eur0(m.packaging)}</b>
      <span>URSSAF (13,4 %)</span><b>${eur0(m.urssaf)}</b>
      <span>Coût effectif (invendus)</span><b>${eur0(m.effective_cost)}</b>
      <span>Marge nette / pièce</span><b class="${m.net > 0 ? "pos" : "neg"}">${eur0(m.net)} (${m.net_pct} %)</b>
      <span>Marge nette du lot</span><b class="${o.net_total > 0 ? "pos" : "neg"}">${eur0(o.net_total)}</b>
      <span>Coefficient revente/achat</span><b>×${(m.coefficient || (m.cost_per_piece ? m.resale / m.cost_per_piece : 0)).toFixed ? (m.coefficient || (m.resale / m.cost_per_piece)).toFixed(2) : m.coefficient}</b>
      <span>Règle du 1/3</span><b>${m.rule_one_third_ok ? "oui" : "non"} (${Math.round(m.cost_ratio * 100)} %)</b>
      <span>Niveau</span><b>${o.quality_level || "—"}</b>
      <span>Saison</span><b>${o.season === "in" ? "de saison" : o.season === "off" ? "hors saison" : "toute année"}</b>
      <span>Score</span><b>${o.score} / 100</b>
    </div>
    ${o.margin_caution ? `<p class="note">${esc(o.margin_caution)}</p>` : ""}
    <a class="btn" href="${esc(o.url)}" target="_blank" rel="noopener">Voir l'offre</a>
    <p class="note">Vérifie le port et l'état sur le site avant d'acheter. Les mentions « estimation » ne sont pas un tarif officiel.</p>`;
  $("#sheet").hidden = false;
}

function renderManuals() {
  const links = DATA.manual_searches || [];
  $("#manuals").innerHTML = links.map(l => `
    <article class="item">
      <div class="t">${esc(l.query)}</div>
      <div class="v">${l.gender ? `<span class="tag ${l.gender === "femme" ? "femme" : l.gender === "homme" ? "homme" : "mixte"}">${l.gender === "femme" ? "Femme" : l.gender === "homme" ? "Homme" : "Mixte"}</span>` : ""}</div>
      <div class="s full">
        <a href="${esc(l.vinted)}" target="_blank" rel="noopener">Vinted</a> ·
        <a href="${esc(l.leboncoin)}" target="_blank" rel="noopener">Leboncoin</a> ·
        <a href="${esc(l.ebay)}" target="_blank" rel="noopener">eBay</a>
      </div>
    </article>`).join("");
}

/* ---------- plan ---------- */
function renderPlan() {
  const rows = [
    ["Mois 1 — 100 € de stock, 80 à 150 € nets", 8],
    ["Vers 3 mois — stock reconstitué, ~300 à 600 € / mois", 25],
    ["Vers 6 mois — premiers lots, ~800 à 1 200 € / mois", 50],
    ["9 à 12 mois — cap 2 000 € nets / mois (~180 ventes)", 85],
    ["Plus loin — 3 000 € nets (~270 ventes, 22–30 h / sem.)", 100]
  ];
  $("#planBars").innerHTML = rows.map(([label, pct]) => `
    <div class="bar"><span>${esc(label)}</span><b>${pct} %</b>
      <div class="track"><div class="fill" style="width:${pct}%"></div></div>
    </div>`).join("");
}

/* ---------- calculator ---------- */
function renderCalc() {
  const resale = Number($("#cResale").value) || 0;
  const cost = Number($("#cCost").value) || 0;
  const pieces = Math.max(1, Number($("#cPieces").value) || 1);
  const lot = $("#cLot").checked;
  const m = netMargin(resale, cost, { lot });
  const totalNet = round2(m.net * pieces);
  const cls = m.rule_one_third_ok && m.net > 0 ? "buy" : m.net > 0 ? "mid" : "pass";
  const badge = cls === "buy" ? "ACHÈTE" : cls === "mid" ? "SERRÉ" : "PASSE";
  const tip = cls === "buy"
    ? "La règle du tiers est respectée et la marge nette est positive."
    : cls === "mid"
      ? "Il resterait un peu de marge, mais tu paies plus d'un tiers du prix de revente : un accroc ou une taille qui dort et tu es dans le rouge."
      : "Après emballage et URSSAF, tu serais à perte ou à l'équilibre. Laisse tomber.";
  $("#cOut").className = "verdict " + cls;
  $("#cOut").innerHTML = `
    <div class="badge">${badge}</div>
    <p>${tip}</p>
    <div class="nums">
      <div><label>Net / pièce</label><b class="${m.net > 0 ? "pos" : "neg"}">${eur0(m.net)}</b></div>
      <div><label>Net du lot</label><b class="${totalNet > 0 ? "pos" : "neg"}">${eur0(totalNet)}</b></div>
      <div><label>Achat / revente</label><b>${Math.round(m.cost_ratio * 100)} %</b></div>
    </div>`;
  const c = cfg();
  $("#cKv").innerHTML = `
    <span>Revente</span><b>${eur0(m.resale)}</b>
    <span>Coût d'achat / pièce</span><b>${eur0(m.cost_per_piece)}</b>
    ${lot ? `<span>Coût effectif (+ ${(c.defect_unsold_rate * 100).toFixed(0)} % invendus)</span><b>${eur0(m.effective_cost)}</b>` : `<span>Coût effectif</span><b>${eur0(m.effective_cost)} (pièce vue, sans réserve d'invendus)</b>`}
    <span>Emballage</span><b>${eur0(m.packaging)}</b>
    <span>URSSAF ${(c.urssaf_rate * 100).toFixed(1).replace(".", ",")} %</span><b>${eur0(m.urssaf)}</b>
    <span>Règle du 1/3 (max ${eur0(m.resale * c.max_cost_ratio)})</span><b>${m.rule_one_third_ok ? "respectée" : "dépassée"}</b>`;
  $("#cNotes").textContent = (c.urssaf_note || "") + " " + (c.packaging_note || "");
}

/* ---------- stock ---------- */
function loadStock() {
  try { return JSON.parse(localStorage.getItem(STOCK_KEY) || "{\"items\":[]}"); }
  catch { return { items: [] }; }
}
function saveStock(data) { localStorage.setItem(STOCK_KEY, JSON.stringify(data)); }

function itemNet(it) {
  if (it.statut !== "vendu" || it.prix_vendu == null || it.prix_vendu === "") return null;
  const cost = (Number(it.prix_achat) || 0) + (Number(it.port_achat) || 0);
  const pack = it.emballage === "" || it.emballage == null ? cfg().packaging_per_item : Number(it.emballage);
  const resale = Number(it.prix_vendu);
  const urssaf = resale * cfg().urssaf_rate;
  return round2(resale - cost - pack - urssaf);
}

function daysBetween(a, b) {
  const da = new Date(a + "T12:00:00"), db = new Date(b + "T12:00:00");
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return null;
  return Math.round((db - da) / 86400000);
}

function zurichNowParts() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", hour: "2-digit", hour12: false }).formatToParts(new Date());
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.find(p => p.type === "weekday").value];
  const hour = Number(parts.find(p => p.type === "hour").value) % 24;
  return { wd, hour };
}

function isWeekendWindow() {
  const { wd, hour } = zurichNowParts();
  return (wd === 5 && hour >= 17) || wd === 6 || wd === 0;
}

function weekendItems() {
  const today = todayISO();
  const items = (loadStock().items || []).filter(i => i.statut !== "vendu");
  return items.map(it => {
    const ref = it.date_mise_en_ligne || it.date_achat || today;
    const days = daysBetween(ref, today) ?? 0;
    const listed = it.statut === "en ligne" && it.date_mise_en_ligne;
    const price = Number(it.prix_affiche) || 0;
    let hint = "";
    if (listed && days >= 30) hint = price ? `−20 % → ${eur0(price * 0.8)}` : "−20 % conseillé";
    else if (listed && days >= 14) hint = price ? `−10 % → ${eur0(price * 0.9)}` : "−10 % conseillé";
    else if (it.statut === "en stock") hint = "à mettre en ligne";
    return { it, days, hint, cost: (Number(it.prix_achat) || 0) + (Number(it.port_achat) || 0) };
  }).sort((a, b) => b.days - a.days);
}

function renderWeekendBanner() {
  const box = $("#weekendBanner");
  if (!box) return;
  if (!isWeekendWindow()) { box.hidden = true; return; }
  const rows = weekendItems();
  if (!rows.length) { box.hidden = true; return; }
  const cash = rows.reduce((s, r) => s + r.cost, 0);
  box.hidden = false;
  box.innerHTML = `
    <div class="card-h"><h2>À vendre avant le week-end</h2><span class="muted">${rows.length} pièce${rows.length > 1 ? "s" : ""}</span></div>
    <div class="bigish">${eur0(cash)} immobilisés</div>
    <p class="note" style="margin:0">Somme des prix d'achat et du port des pièces non vendues. Les plus anciennes d'abord. Baisse suggérée : −10 % après 14 jours en ligne, −20 % après 30 jours.</p>
    <ul class="weekend-list">${rows.slice(0, 12).map(r => `
      <li><span>${esc(r.it.marque)} · ${esc(r.it.article)} <span class="muted">(${r.days} j · ${esc(r.it.statut)})</span></span><span class="hint">${esc(r.hint || eur0(r.cost))}</span></li>`).join("")}
    </ul>`;
}

async function maybeWeekendNotification() {
  if (!isWeekendWindow()) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const key = todayISO();
  if (localStorage.getItem(WEEKEND_NOTIF_KEY) === key) return;
  const rows = weekendItems();
  if (!rows.length) return;
  const cash = rows.reduce((s, r) => s + r.cost, 0);
  await notify("À vendre avant le week-end", `${rows.length} pièce${rows.length > 1 ? "s" : ""} non vendue${rows.length > 1 ? "s" : ""} · ${eur0(cash)} immobilisés`, "./#stock", "sourcing-weekend");
  localStorage.setItem(WEEKEND_NOTIF_KEY, key);
}

function renderStock() {
  renderWeekendBanner();
  const data = loadStock();
  const items = data.items || [];
  const sold = items.filter(i => i.statut === "vendu");
  const profit = sold.reduce((s, i) => s + (itemNet(i) || 0), 0);
  const nStock = items.filter(i => i.statut === "en stock").length;
  const nLive = items.filter(i => i.statut === "en ligne").length;
  $("#sProfit").textContent = eur0(profit);
  $("#sProfit").className = "big " + (profit > 0 ? "pos" : profit < 0 ? "neg" : "");
  $("#sDelta").textContent = sold.length ? `${sold.length} vente${sold.length > 1 ? "s" : ""}` : "aucune vente pour l'instant";
  $("#sStock").textContent = nStock;
  $("#sLive").textContent = nLive;
  $("#sSold").textContent = sold.length;

  const view = stockFilter === "all" ? items : items.filter(i => i.statut === stockFilter);
  if (!view.length) {
    $("#stockList").innerHTML = `<div class="card"><p class="note" style="margin:0">Aucun article de ce côté-là. Ajoute un achat ci-dessus.</p></div>`;
    return;
  }
  $("#stockList").innerHTML = view.slice().reverse().map(it => {
    const cost = (Number(it.prix_achat) || 0) + (Number(it.port_achat) || 0);
    const net = itemNet(it);
    const stTag = it.statut === "vendu" ? "ok" : it.statut === "en ligne" ? "cy" : "";
    return `<article class="item">
      <div class="t">${esc(it.marque)} · ${esc(it.article)}</div>
      <div class="v ${net == null ? "" : net >= 0 ? "pos" : "neg"}">${net == null ? eur0(cost) : eur0(net)}</div>
      <div class="s">${esc(it.taille || "—")} · acheté ${esc(it.date_achat || "—")} · ${esc(it.source || "")}</div>
      <div class="w"><span class="tag ${stTag}">${esc(it.statut)}</span></div>
      <div class="full row-btns">
        ${it.statut === "en stock" ? `<button type="button" class="btn ghost small" data-act="list" data-id="${esc(it.id)}">Mettre en ligne</button>` : ""}
        ${it.statut !== "vendu" ? `<button type="button" class="btn ghost small" data-act="sold" data-id="${esc(it.id)}">Marquer vendu</button>` : ""}
        <button type="button" class="btn ghost small" data-act="del" data-id="${esc(it.id)}">Supprimer</button>
      </div>
    </article>`;
  }).join("");
}

function stockAction(act, id) {
  const data = loadStock();
  const it = data.items.find(x => x.id === id);
  if (!it) return;
  if (act === "del") {
    if (!confirm("Supprimer cet article du suivi ?")) return;
    data.items = data.items.filter(x => x.id !== id);
  } else if (act === "list") {
    it.statut = "en ligne";
    it.date_mise_en_ligne = it.date_mise_en_ligne || todayISO();
    const p = prompt("Prix affiché sur Vinted (€) ?", it.prix_affiche || "");
    if (p != null && p !== "") it.prix_affiche = Number(p);
  } else if (act === "sold") {
    const p = prompt("Prix vendu, payé par l'acheteur au vendeur (€) ?", it.prix_affiche || it.prix_vendu || "");
    if (p == null || p === "") return;
    it.prix_vendu = Number(p);
    it.date_vente = todayISO();
    it.statut = "vendu";
    if (it.emballage === "" || it.emballage == null) it.emballage = cfg().packaging_per_item;
  }
  saveStock(data);
  renderStock();
}

function addStock(e) {
  e.preventDefault();
  const data = loadStock();
  data.items.push({
    id: uid(),
    date_achat: $("#sDate").value,
    source: $("#sSource").value.trim(),
    marque: $("#sBrand").value.trim(),
    article: $("#sItem").value.trim(),
    taille: $("#sSize").value.trim(),
    prix_achat: Number($("#sPrice").value) || 0,
    port_achat: Number($("#sShip").value) || 0,
    date_mise_en_ligne: "",
    prix_affiche: "",
    date_vente: "",
    prix_vendu: "",
    emballage: cfg().packaging_per_item,
    statut: "en stock"
  });
  saveStock(data);
  e.target.reset();
  $("#sDate").value = todayISO();
  $("#sShip").value = "0";
  renderStock();
}

function exportCsv() {
  const headers = ["id","date_achat","source","marque","article","taille","prix_achat","port_achat","date_mise_en_ligne","prix_affiche","date_vente","prix_vendu","emballage","statut"];
  const items = loadStock().items || [];
  const lines = [headers.join(",")].concat(items.map(it => headers.map(h => {
    const v = it[h] ?? "";
    const s = String(v);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")));
  const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "suivi_stock.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

function parseCsv(text) {
  const raw = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(l => l.trim());
  if (!raw.length) return [];
  const split = line => {
    const out = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ",") out.push(cur), cur = "";
      else cur += c;
    }
    out.push(cur); return out;
  };
  const headers = split(raw[0]);
  return raw.slice(1).map(line => {
    const cols = split(line); const o = {};
    headers.forEach((h, i) => o[h] = cols[i] ?? "");
    if (!o.id) o.id = uid();
    if (!o.statut) o.statut = o.date_vente ? "vendu" : o.date_mise_en_ligne ? "en ligne" : "en stock";
    return o;
  });
}

function importCsv(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const rows = parseCsv(String(reader.result || ""));
    if (!rows.length) return alert("Fichier vide ou illisible.");
    const data = loadStock();
    const ids = new Set(data.items.map(i => i.id));
    for (const r of rows) {
      if (ids.has(r.id)) {
        const i = data.items.findIndex(x => x.id === r.id);
        data.items[i] = { ...data.items[i], ...r };
      } else data.items.push(r);
    }
    saveStock(data);
    renderStock();
  };
  reader.readAsText(file, "utf-8");
}

/* ---------- photo / achat éclair ---------- */
function maxBuyPrice(resale) {
  const c = cfg();
  const third = resale * (c.max_cost_ratio || 0.3334);
  const breakEven = resale - (c.packaging_per_item || 0.4) - resale * (c.urssaf_rate || 0.134);
  return round2(Math.max(0, Math.min(third, breakEven)));
}

function renderPhoto() {
  const brand = $("#pBrand").value;
  const type = $("#pType").value;
  const cond = $("#pCond").value;
  const priceRaw = $("#pPrice").value;
  const hasPrice = priceRaw !== "" && Number(priceRaw) >= 0;
  const price = hasPrice ? Number(priceRaw) : null;
  const box = $("#pOut");
  if (!brand) {
    box.className = "verdict";
    box.innerHTML = `<p class="muted" style="margin:0">Indique la marque (puis le type et l'état). Le prix demandé est optionnel : sans prix, tu vois déjà le prix d'achat max.</p>`;
    $("#pShare").disabled = !photoFile && !brand;
    return;
  }
  const { resale, basis, brand: b } = resaleFor(brand, type, cond);
  const maxBuy = maxBuyPrice(resale);
  const mAsk = hasPrice ? netMargin(resale, price, { lot: false }) : null;
  const mMax = netMargin(resale, maxBuy, { lot: false });
  const avoid = b && /éviter/i.test(b.brand);
  let cls, badge, tip;
  if (avoid) {
    cls = "pass"; badge = "NON";
    tip = `${b.brand} se vend, mais trop bon marché : après emballage et URSSAF, la marge s'évapore. Cherche plutôt Ralph Lauren, Carhartt, The North Face, Patagonia, Lacoste ou Levi's.`;
  } else if (!hasPrice) {
    cls = "buy"; badge = "MAX";
    tip = `Revente de référence : ${eur0(resale)} (${basis}). N'achète pas au-dessus de ${eur0(maxBuy)} (le plus bas entre un tiers de la revente et le prix qui reste à l'équilibre après emballage et URSSAF).`;
  } else if (price <= maxBuy) {
    cls = "buy"; badge = "OUI";
    tip = `Revente de référence : ${eur0(resale)} (${basis}). À ${eur0(price)}, il resterait environ ${eur0(mAsk.net)} nets. Le plafond est ${eur0(maxBuy)}.`;
  } else {
    cls = "pass"; badge = "NON";
    tip = `Revente de référence : ${eur0(resale)} (${basis}). À ${eur0(price)}, ${mAsk.net > 0 ? "la marge existe encore mais le prix dépasse le maximum conseillé" : "après emballage et URSSAF tu serais à " + eur0(mAsk.net)}. Plafond : ${eur0(maxBuy)}.`;
  }
  if (b && b.sales) tip += ` Volume observé : ${b.sales.toLocaleString("fr-FR")} ventes sur 12 mois, fourchette ${eur0(b.low)} – ${eur0(b.high)}.`;
  box.className = "verdict flash " + cls;
  box.innerHTML = `
    <div class="badge">${badge}</div>
    <p>${esc(tip)}</p>
    <div class="nums">
      <div class="max"><label>Prix d'achat max</label><b class="pos">${eur0(maxBuy)}</b></div>
      <div><label>Revente estimée</label><b>${eur0(resale)}</b></div>
      <div><label>Marge au prix max</label><b class="${mMax.net > 0 ? "pos" : "neg"}">${eur0(mMax.net)}</b></div>
      ${hasPrice ? `<div><label>Marge au prix demandé</label><b class="${mAsk.net > 0 ? "pos" : "neg"}">${eur0(mAsk.net)}</b></div>
      <div><label>Achat / revente</label><b>${Math.round(mAsk.cost_ratio * 100)} %</b></div>` : `<div><label>Règle du 1/3</label><b>${eur0(resale * cfg().max_cost_ratio)}</b></div>`}
    </div>
    <p class="note">L'outil ne « voit » pas la photo : il s'appuie sur ce que tu as indiqué. Pour un avis sur l'état réel, l'étiquette ou un défaut, partage la photo dans le chat.</p>`;
  $("#pShare").disabled = !(photoFile || brand);
}

async function sharePhoto() {
  if (!photoFile && !$("#pBrand").value) return alert("Indique au moins la marque, et ajoute une photo si tu peux.");
  const brand = $("#pBrand").value || "marque ?";
  const price = $("#pPrice").value;
  const badge = ($("#pOut .badge") || {}).textContent || "";
  const maxEl = $("#pOut .nums .max b");
  const maxTxt = maxEl ? maxEl.textContent : "";
  const text = `Achat éclair Vinted — ${brand}, prix demandé ${price || "non indiqué"} €. Verdict : ${badge || "à voir"}. Prix d'achat max : ${maxTxt || "?"}.`;
  const file = photoFile;
  const payload = { title: "Achat éclair Vinted", text };
  try {
    if (file && navigator.share && navigator.canShare && navigator.canShare({ files: [file], ...payload })) {
      await navigator.share({ files: [file], ...payload });
      return;
    }
    if (navigator.share) {
      await navigator.share(payload);
      return;
    }
  } catch (err) {
    if (err && err.name === "AbortError") return;
  }
  // repli : télécharger la photo + copier le texte
  try { await navigator.clipboard.writeText(text); } catch {}
  if (file) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file);
    a.download = file.name || "piece-vinted.jpg";
    a.click();
    URL.revokeObjectURL(a.href);
  }
  alert("Le résumé a été copié si possible" + (file ? ", et la photo a été enregistrée (ou proposée au téléchargement)" : "") + ". Envoie la photo dans notre chat pour un avis visuel.");
}

function onPhotoFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  photoFile = file;
  const url = URL.createObjectURL(file);
  const img = $("#pPreview");
  img.src = url;
  img.hidden = false;
  $("#pEmpty").hidden = true;
  $("#pShare").disabled = false;
  renderPhoto();
}

/* ---------- header / hero ---------- */
function renderHero() {
  const budget = DATA.budget || 100;
  const offs = DATA.offers || [];
  const inB = offs.filter(o => o.total_price <= budget).length;
  const net = offs.filter(o => o.margin && o.margin.net > 0).length;
  $("#hBudget").textContent = eur0(budget);
  $("#budgetPill").textContent = "Budget " + eur0(budget).replace(",00", "");
  $("#hOffers").textContent = offs.length.toLocaleString("fr-FR") + " offres trouvées";
  $("#hInBudget").textContent = inB.toLocaleString("fr-FR");
  $("#hNetPos").textContent = net.toLocaleString("fr-FR");
  const short = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: TZ }).format(new Date(DATA.generated_at));
  $("#hDate").textContent = short;
  $("#liveTxt").textContent = "MAJ " + short;
  $("#livePill").classList.add("ok");
}

function fillBrandList() {
  const names = (DATA.brands || []).map(b => b.brand.replace(/\s*\(.*\)/, ""));
  $("#brandList").innerHTML = names.map(n => `<option value="${esc(n)}">`).join("");
}

/* ---------- PWA install ---------- */
function showInstall(forceHelp = false) {
  const bar = $("#installBar");
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (standalone) { bar.hidden = true; return; }
  if (sessionStorage.getItem("sourcing-hide-install") && !forceHelp && !deferredPrompt) { bar.hidden = true; return; }
  bar.hidden = false;
  $("#installBtn").hidden = !deferredPrompt;
}

function installHelp() {
  openSheetHtml(`
    <h3>Installer l'appli sur Samsung</h3>
    <p>Ce n'est pas une appli du Play Store : c'est un site installable, comme Vortex et Nexus. Utilise <b>Chrome</b> (pas Samsung Internet, qui colle parfois un badge sur l'icône).</p>
    <ol style="color:var(--mute);padding-left:18px;line-height:1.6">
      <li>Ouvre ce site dans <b>Chrome</b>.</li>
      <li>Appuie sur le menu en haut à droite (les trois points verticaux).</li>
      <li>Choisis <b>Installer l'application</b> ou <b>Ajouter à l'écran d'accueil</b>.</li>
      <li>Valide. L'icône Sourcing (étiquette or) s'ouvre en plein écran, sans barre d'adresse.</li>
    </ol>
    <p class="note">Sur ordinateur, Chrome propose aussi « Installer » dans la barre d'adresse. Les données de stock restent dans ce navigateur : installe depuis le téléphone que tu emmèneras en friperie.</p>`);
}

function openSheetHtml(html) {
  $("#sheetBody").innerHTML = html;
  $("#sheet").hidden = false;
}

/* ---------- sky (fond discret, style observatoire) ---------- */
function sky() {
  const c = $("#sky");
  if (!c || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const ctx = c.getContext("2d");
  const stars = [];
  function resize() {
    c.width = innerWidth; c.height = innerHeight;
    stars.length = 0;
    const n = Math.min(90, Math.floor(innerWidth * innerHeight / 18000));
    for (let i = 0; i < n; i++) stars.push({
      x: Math.random() * c.width, y: Math.random() * c.height,
      r: Math.random() * 1.2 + 0.2, a: Math.random() * 0.35 + 0.05, s: Math.random() * 0.4 + 0.1
    });
  }
  let t = 0, raf;
  function draw() {
    t += 0.01;
    ctx.clearRect(0, 0, c.width, c.height);
    for (const s of stars) {
      ctx.beginPath();
      ctx.fillStyle = `rgba(239,234,249,${s.a + Math.sin(t * s.s + s.x) * 0.08})`;
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    raf = requestAnimationFrame(draw);
  }
  resize(); draw();
  addEventListener("resize", resize, { passive: true });
}

/* ---------- alertes ---------- */
function loadSeen() {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || "[]")); }
  catch { return new Set(); }
}
function saveSeen(set) {
  const arr = [...set].slice(-3000);
  localStorage.setItem(SEEN_KEY, JSON.stringify(arr));
  // Partage aussi la liste avec le service worker (Periodic Background Sync).
  if ("caches" in window) {
    caches.keys().then(keys => {
      const k = keys.find(x => x.startsWith("sourcing-"));
      if (!k) return;
      return caches.open(k).then(c => c.put(SEEN_CACHE_PATH, new Response(JSON.stringify(arr), { headers: { "Content-Type": "application/json" } })));
    }).catch(() => {});
  }
}

async function notify(title, body, url, tag) {
  if (!("Notification" in window) || Notification.permission !== "granted") return false;
  const opts = { body, icon: "icons/icon-192.png", badge: "icons/icon-192.png", tag: tag || "sourcing", data: { url: url || "./#offres" } };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg && reg.showNotification) { await reg.showNotification(title, opts); return true; }
  } catch {}
  try { new Notification(title, opts); return true; } catch {}
  return false;
}

function updateAlertBtn() {
  const btn = $("#alertBtn");
  if (!btn) return;
  if (!("Notification" in window)) { btn.textContent = "Alertes indisponibles"; btn.disabled = true; return; }
  const on = Notification.permission === "granted";
  btn.classList.toggle("on", on);
  btn.textContent = on ? "Alertes activées" : Notification.permission === "denied" ? "Alertes bloquées" : "Activer les alertes";
}

async function enableAlerts() {
  if (!("Notification" in window)) return alert("Ce navigateur ne gère pas les notifications. Utilise Chrome sur Android, site installé.");
  if (Notification.permission === "denied") {
    return openSheetHtml("<h3>Alertes bloquées</h3><p>Dans Chrome : ⋮ → Paramètres → Paramètres des sites → Notifications, puis autorise ce site. Ou appuie sur le cadenas à gauche de l'adresse.</p>");
  }
  const perm = await Notification.requestPermission();
  updateAlertBtn();
  if (perm !== "granted") return;
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg && "periodicSync" in reg) {
      const status = await navigator.permissions.query({ name: "periodic-background-sync" }).catch(() => null);
      if (!status || status.state === "granted") {
        await reg.periodicSync.register("sourcing-alerts", { minInterval: 12 * 60 * 60 * 1000 });
      }
    }
  } catch {}
  await notify("Alertes activées", "Tu seras prévenu à l'ouverture de l'appli quand de nouvelles offres correspondent à tes critères.", "./#offres", "sourcing-on");
  checkAlerts(true);
}

async function checkAlerts(silentFirst = false) {
  let data;
  try {
    const r = await fetch("data/alerts.json", { cache: "no-cache" });
    if (!r.ok) return;
    data = await r.json();
  } catch { return; }
  const offers = data.offers || [];
  const seen = loadSeen();
  const firstRun = !localStorage.getItem(SEEN_KEY);
  const fresh = offers.filter(o => o.id && !seen.has(o.id));
  // Marque aussi comme vues les offres déjà dans la liste principale (premier lancement).
  if (firstRun && !silentFirst) {
    (DATA?.offers || []).forEach(o => { if (o.id && !o.is_new) seen.add(o.id); });
  }
  if (fresh.length && Notification?.permission === "granted") {
    const top = fresh[0];
    const net = top.margin ? `${eur0(top.margin.net)} nets/pc` : "";
    await notify(
      fresh.length === 1 ? "Nouvelle offre sourcing" : `${fresh.length} nouvelles offres sourcing`,
      [top.title, net].filter(Boolean).join(" · ") + (fresh.length > 1 ? ` et ${fresh.length - 1} autre${fresh.length > 2 ? "s" : ""}` : ""),
      "./#offres",
      "sourcing-new-offers"
    );
  }
  fresh.forEach(o => seen.add(o.id));
  saveSeen(seen);
}

/* ---------- boot ---------- */
async function boot() {
  sky();
  try {
    const [offers, brands] = await Promise.all([
      fetch("data/offers.json", { cache: "no-cache" }).then(r => { if (!r.ok) throw r; return r.json(); }),
      fetch("data/brands.json", { cache: "no-cache" }).then(r => { if (!r.ok) throw r; return r.json(); })
    ]);
    DATA = offers;
    DATA.brands = (brands.brands || brands);
    DATA.brands_source_note = brands.source_note;
  } catch (e) {
    $("#liveTxt").textContent = "données introuvables";
    $("#livePill").classList.add("bad");
    openSheetHtml("<h3>Données manquantes</h3><p>Impossible de charger data/offers.json. Ouvre le site via le serveur local ou la page publiée, pas en glissant le fichier dans le navigateur.</p>");
    return;
  }

  renderHero();
  renderBrands();
  populateFilters();
  renderOffers();
  renderManuals();
  renderPlan();
  renderCalc();
  fillBrandList();
  $("#sDate").value = todayISO();
  renderStock();
  renderPhoto();

  const tab = (location.hash || "#offres").replace("#", "");
  showTab($(`#t-${tab}`) ? tab : "offres");

  if ("serviceWorker" in navigator) {
    try {
      const reg = await navigator.serviceWorker.register("sw.js", { updateViaCache: "none" });
      reg.update().catch(() => {});
      let reloaded = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloaded) return; reloaded = true; location.reload();
      });
    } catch {}
  }
  showInstall();
  updateAlertBtn();
  checkAlerts();
  maybeWeekendNotification();
}

$("#tabs").addEventListener("click", e => {
  const b = e.target.closest("button");
  if (b && b.dataset.t) showTab(b.dataset.t);
});
addEventListener("hashchange", () => {
  const id = location.hash.replace("#", "");
  if ($(`#t-${id}`)) showTab(id);
});

["fBudget", "fSource", "fBrand", "fGender", "fSort"].forEach(id => {
  document.addEventListener("change", e => { if (e.target.id === id) renderOffers(); });
});
$("#fFlags").addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b) return;
  flagMode = b.dataset.flag;
  $$("#fFlags button").forEach(x => x.classList.toggle("on", x === b));
  renderOffers();
});
["cResale", "cCost", "cPieces", "cLot"].forEach(id => {
  $("#" + id).addEventListener("input", renderCalc);
  $("#" + id).addEventListener("change", renderCalc);
});

$("#stockForm").addEventListener("submit", addStock);
$("#stockList").addEventListener("click", e => {
  const b = e.target.closest("button[data-act]");
  if (b) stockAction(b.dataset.act, b.dataset.id);
});
$("#sFilter").addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b) return;
  stockFilter = b.dataset.st;
  $$("#sFilter button").forEach(x => x.classList.toggle("on", x === b));
  renderStock();
});
$("#sExport").addEventListener("click", exportCsv);
$("#sImport").addEventListener("change", e => { const f = e.target.files[0]; if (f) importCsv(f); e.target.value = ""; });

$("#pFile").addEventListener("change", e => onPhotoFile(e.target.files[0]));
["pBrand", "pType", "pCond", "pPrice"].forEach(id => {
  $("#" + id).addEventListener("input", renderPhoto);
  $("#" + id).addEventListener("change", renderPhoto);
});
$("#pShare").addEventListener("click", sharePhoto);

$("#sheetX").addEventListener("click", () => { $("#sheet").hidden = true; });
$("#sheet").addEventListener("click", e => { if (e.target.id === "sheet") $("#sheet").hidden = true; });

$("#installBtn").addEventListener("click", async () => {
  if (!deferredPrompt) return installHelp();
  deferredPrompt.prompt();
  await deferredPrompt.userChoice.catch(() => {});
  deferredPrompt = null;
  $("#installBar").hidden = true;
});
$("#installHelp").addEventListener("click", installHelp);
$("#alertBtn").addEventListener("click", enableAlerts);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !DATA) return;
  checkAlerts();
  renderWeekendBanner();
  maybeWeekendNotification();
});
$("#installX").addEventListener("click", () => {
  sessionStorage.setItem("sourcing-hide-install", "1");
  $("#installBar").hidden = true;
});
addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  deferredPrompt = e;
  showInstall();
});

boot();
