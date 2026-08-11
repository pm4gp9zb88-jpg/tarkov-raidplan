// RaidPlan data synchroniser — prerequisite-aware
// Node.js 18+
// Combines json.tarkov.dev structured data with the current Escape from Tarkov Fandom Wiki.
// The Wiki is used as a validation layer so struck/deleted objectives are not treated as current.
//
// Run:
//   node sync-data.mjs
//
// Outputs:
//   tasks.snapshot.json
//   data-audit.json
//
// No third-party npm packages are required.

import { writeFile, readFile } from "node:fs/promises";

const TARKOV_BASE = "https://json.tarkov.dev";
const FANDOM_API = "https://escapefromtarkov.fandom.com/api.php";
const MODE = "regular";
const CONCURRENCY = 5;
const REQUEST_DELAY_MS = 120;

const arr = v => Array.isArray(v) ? v : (v && typeof v === "object" ? Object.values(v) : []);
const clean = s => String(s ?? "").replace(/\s+/g, " ").trim();
const uniq = a => [...new Set(a.filter(Boolean))];
const idOf = v => typeof v === "string" ? v : (v && typeof v === "object" ? (v.id || v._id || "") : "");
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parsePath(path) {
  if (typeof path !== "string" || !path.startsWith("$.")) return null;
  return path.slice(2).split(".").map(part =>
    part === "*" ? { kind: "wild" } :
    part.endsWith("[*]") ? { kind: "array", key: part.slice(0, -3) } :
    { kind: "key", key: part }
  );
}
function applyTranslation(root, steps, dict, i = 0) {
  if (root == null || typeof root !== "object" || i >= steps.length) return;
  const s = steps[i], last = i === steps.length - 1;
  if (s.kind === "wild") {
    for (const k of Object.keys(root)) {
      if (last) {
        const v = root[k];
        if (typeof v === "string" && dict[v] !== undefined) root[k] = dict[v];
      } else applyTranslation(root[k], steps, dict, i + 1);
    }
    return;
  }
  if (s.kind === "array") {
    const a = root[s.key];
    if (!Array.isArray(a)) return;
    for (let k = 0; k < a.length; k++) {
      if (last) {
        const v = a[k];
        if (typeof v === "string" && dict[v] !== undefined) a[k] = dict[v];
      } else applyTranslation(a[k], steps, dict, i + 1);
    }
    return;
  }
  if (last) {
    const v = root[s.key];
    if (typeof v === "string" && dict[v] !== undefined) root[s.key] = dict[v];
  } else applyTranslation(root[s.key], steps, dict, i + 1);
}
async function translated(endpoint) {
  const [b, e] = await Promise.all([
    fetch(`${TARKOV_BASE}/${MODE}/${endpoint}`),
    fetch(`${TARKOV_BASE}/${MODE}/${endpoint}_en`)
  ]);
  if (!b.ok) throw new Error(`${endpoint}: ${b.status}`);
  const base = await b.json();
  const en = e.ok ? await e.json() : { data: {} };
  const copy = structuredClone(base);
  const dict = en.data || {};
  for (const p of copy.translations || []) {
    const steps = parsePath(p);
    if (steps) applyTranslation(copy, steps, dict);
  }
  return copy.data;
}
function lookup(data, key) {
  const m = new Map();
  for (const x of arr(data?.[key] ?? data)) {
    const id = idOf(x);
    if (id) m.set(id, x);
  }
  return m;
}
function ref(v, ...ls) {
  if (v && typeof v === "object") return v;
  const id = idOf(v);
  for (const l of ls) {
    const x = l?.get(id);
    if (x) return x;
  }
  return { id };
}
function name(v, ...ls) {
  const x = ref(v, ...ls);
  return clean(x.name || x.shortName || x.normalizedName || "");
}
function qty(o) {
  for (const n of [o?.count, o?.quantity, o?.requiredCount, o?.amount]) {
    if (Number(n) > 0) return Number(n);
  }
  return 1;
}
function objectiveText(o) {
  return clean(o.description || o.name || o.text || o.type || "Objective");
}
function category(o) {
  const t = clean(o.type || o.__typename).toLowerCase();
  const d = objectiveText(o).toLowerCase();
  if (o.markerItem || t.includes("mark") || d.includes("mark ") || d.includes("plant ") || d.includes("place ")) return "Place";
  if (o.usingWeapon || t.includes("kill") || d.includes("eliminate") || d.includes("kill ")) return "Kill";
  if (o.item || o.items || o.questItem || t.includes("find") || t.includes("give") || d.includes("find ") || d.includes("hand over")) return "Find / Hand over";
  if (t.includes("visit") || t.includes("location") || d.includes("locate ")) return "Locate";
  if (d.includes("survive") || d.includes("extract")) return "Survive";
  return "Other";
}
function mapNames(o, maps) {
  return uniq([
    ...arr(o.maps).map(x => name(x, maps)),
    ...arr(o.zones).map(x => name(x?.map, maps)),
    ...arr(o.possibleLocations).map(x => name(x?.map, maps))
  ]);
}
function itemList(v, quest) {
  const raw = Array.isArray(v) ? v : (v ? [v] : []);
  const out = [];
  for (const x of raw) {
    if (Array.isArray(x)) for (const y of x) out.push({ id: idOf(y), name: name(y, quest) });
    else out.push({ id: idOf(x), name: name(x, quest) });
  }
  return out.filter(x => x.id || x.name);
}
function slotForName(n) {
  const s = clean(n).toLowerCase();
  const hints = {
    armor:["body armor","body armour","paca","untar armor","untar armour","korund","zhuk","fort armor","fort armour","6b13","6b23","6b43"],
    rig:["tactical rig","chest rig","scav vest","security vest","bank robber"],
    headwear:["helmet","ushanka","cap","hat","beanie"],
    facecover:["balaclava","mask","respirator","shemagh"],
    eyewear:["glasses","goggles","eyewear"],
    earpiece:["headset","earpiece","comtac","sordin","razor"]
  };
  for (const [slot, words] of Object.entries(hints)) if (words.some(w => s.includes(w))) return slot;
  return null;
}
function tidyGearPhrase(value) {
  let s = clean(value)
    .replace(/^[\s:;-]+|[\s:;,.!-]+$/g, "")
    .replace(/^(?:an?|the|any)\s+/i, "")
    .replace(/\s+/g, " ");
  s = s.replace(/\s+(?:on|at|in)\s+(?:Customs|Shoreline|Reserve|Woods|Interchange|Factory|Lighthouse|Streets(?: of Tarkov)?|Ground Zero|The Lab|Labs)\b.*$/i, "");
  return s.trim();
}
function looksWeapon(v) {
  const s = clean(v).toLowerCase();
  return /\b(?:weapon|weapons|rifle|rifles|shotgun|shotguns|pistol|pistols|smg|smgs|carbine|carbines|sniper|assault rifle|marksman rifle|machine gun|akm|ak-?\d|aks-?\d|svd|sv-?\d|m4a1|m4|m1a|mp-?\d|vpo-?\d|sa-?\d|rsass|adar|mosin|revolver|suppressed)\b/i.test(s);
}
function inferWeapon(text) {
  const d = clean(text), out = [];
  const patterns = [
    /\bwhile using\s+(?:(?:an?|the|any)\s+)?([^,.;]+?)(?=\s+(?:on|at|in|from|while|without|during)\b|[,.;]|$)/ig,
    /\busing\s+(?:(?:an?|the|any)\s+)?([^,.;]+?)(?=\s+(?:on|at|in|from|while|without|during)\b|[,.;]|$)/ig,
    /\bwith\s+(?:(?:an?|the|any)\s+)?([^,.;]+?(?:weapon(?:s)?|rifle(?:s)?|shotgun(?:s)?|pistol(?:s)?|smg(?:s)?|carbine(?:s)?|sniper rifle(?:s)?|assault rifle(?:s)?|marksman rifle(?:s)?|machine gun(?:s)?))(?=\s+(?:on|at|in|from|while|during)\b|[,.;]|$)/ig
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(d))) {
      const p = tidyGearPhrase(m[1]);
      if (looksWeapon(p)) out.push(p);
    }
  }

  const usingTail=d.match(/\b(?:while\s+)?using\s+(.+)$/i);
  if(usingTail){
    for(const part of usingTail[1].split(/\s*,\s*|\s+\band\b\s+/i)){
      const p=tidyGearPhrase(clean(part).replace(/^and\s+/i,""));
      if(looksWeapon(p))out.push(p);
    }
  }

  return uniq(out);
}
function inferMarker(text) {
  const d = clean(text);
  if (/\bmark\b/i.test(d) && /\bMS2000\s+Marker\b/i.test(d)) return { name:"MS2000 Marker", qty:1 };
  const m = d.match(/\b(?:with|using)\s+(?:an?\s+)?([^,.;]*\bMarker\b)/i);
  return m ? { name: tidyGearPhrase(m[1]), qty:1 } : null;
}

function statusArray(v) {
  if (Array.isArray(v)) return v.map(x => clean(typeof x === "string" ? x : (x?.name || x?.status || x?.value || ""))).filter(Boolean);
  if (typeof v === "string") return [clean(v)].filter(Boolean);
  if (v && typeof v === "object") return Object.values(v).map(x => clean(typeof x === "string" ? x : (x?.name || x?.status || x?.value || ""))).filter(Boolean);
  return [];
}
function normalizeTaskRequirements(t) {
  return arr(t?.taskRequirements).map(r => {
    const taskId = idOf(r?.task || r?.requiredTask || r?.requirement || r);
    const statuses = uniq([
      ...statusArray(r?.status),
      ...statusArray(r?.statuses),
      ...statusArray(r?.requiredStatus)
    ]);
    return taskId ? { taskId, statuses } : null;
  }).filter(Boolean);
}


const RAID_MAP_ANY="Any";
function specificMaps(v){return uniq(arr(v).map(clean).filter(x=>x && x!==RAID_MAP_ANY))}
function raidClassForObjective(record){
  const text=clean(record?.text).toLowerCase();
  const maps=specificMaps(record?.maps);
  const cat=clean(record?.category);
  const raw=clean(record?.rawType).toLowerCase();
  const fir=arr(record?.fir);

  if(maps.length)return "MAP_BOUND";
  if(fir.length)return "ANY_RAID";

  // Structured/combat/location objectives necessarily require a raid even without a fixed map.
  if(["Kill","Place","Locate","Survive"].includes(cat))return "ANY_RAID";
  if(/shoot|kill|visit|location|mark|plant|place|extract|survive/i.test(raw))return "ANY_RAID";

  // Strong wording that clearly requires the PMC to enter a raid/location.
  if(/\b(?:eliminate|kill|survive|extract|locate|visit|discover|mark|plant|place|stash|hide|install|use the transit|transit from|reach the|scout|search the|pick up|retrieve|secure the package|find .*\bin raid\b|obtain .*\bin raid\b|find .*\bduring (?:a |the )?raid\b|obtain .*\bduring (?:a |the )?raid\b)\b/i.test(text))return "ANY_RAID";

  // Explicit non-raid/shop/stash actions. These objectives may be prerequisites, but are not raid-plannable.
  if(/\b(?:modify|build|assemble|craft|purchase|buy|sell|hand over|turn in|give .* to|talk to|ask .* about|return to .* and ask|reach loyalty level|reach level|pay |transfer |insure |repair |complete the weapon|comply with .*specification)\b/i.test(text))return "NON_RAID";

  // A generic find/obtain objective is not assumed to require a raid unless FIR/map data says so.
  if(cat==="Find / Hand over")return "NON_RAID";
  return "NON_RAID";
}
function finalizeObjectiveRaid(record){
  const maps=specificMaps(record?.maps);
  const next={...record,maps};
  next.raidClass=raidClassForObjective(next);
  next.raidRequired=next.raidClass!=="NON_RAID";
  return next;
}
function taskRaidMeta(records){
  const rs=arr(records).map(finalizeObjectiveRaid);
  const mapBoundMaps=uniq(rs.filter(o=>o.raidClass==="MAP_BOUND").flatMap(o=>o.maps||[]));
  const hasAnyRaidObjectives=rs.some(o=>o.raidClass==="ANY_RAID");
  const raidRelevant=mapBoundMaps.length>0 || hasAnyRaidObjectives;
  return {
    objectiveRecords:rs,
    raidRelevant,
    raidClass:mapBoundMaps.length?"MAP_BOUND":hasAnyRaidObjectives?"ANY_RAID":"NON_RAID",
    mapBoundMaps,
    hasAnyRaidObjectives
  };
}
function publicObjectiveDetails(records){
  return arr(records).map(o=>({
    text:o.text,
    category:o.category,
    maps:specificMaps(o.maps),
    raidClass:o.raidClass||raidClassForObjective(o),
    raidRequired:(o.raidClass||raidClassForObjective(o))!=="NON_RAID"
  }));
}

function normalizeTask(t, ctx) {
  const os = arr(t.objectives);
  const tm = name(t.map, ctx.maps);
  let maps = uniq([tm, ...os.flatMap(o => mapNames(o, ctx.maps))]);
  if (!maps.length) maps = ["Any"];

  let objectiveRecords = os.map(o => {
    const text = objectiveText(o);
    const rawType=clean(o.type||o.__typename||"");
    const objectiveMaps=mapNames(o,ctx.maps);
    const requirements = [], restrictions = [], fir = [];
    const add = (kind, n, count=1, slot=null, itemId="") => {
      n = clean(n); if (!n) return;
      requirements.push({ kind, name:n, qty:Number(count)||1, slot, itemId, sourceObjective:text });
    };

    for (const group of arr(o.requiredKeys)) {
      const names = (Array.isArray(group) ? group : [group]).map(x => name(x, ctx.quest)).filter(Boolean);
      if (names.length) add("key", names.join(" OR "));
    }

    let hasMarker = false;
    if (o.markerItem) {
      const n = name(o.markerItem, ctx.quest);
      if (n) { add("item", n, qty(o), null, idOf(o.markerItem)); hasMarker = true; }
    }
    if (!hasMarker) {
      const m = inferMarker(text);
      if (m) add("item", m.name, m.qty);
    }

    for (const w of itemList(o.usingWeapon, ctx.quest)) add("gear", w.name, 1, "weapon", w.id);
    for (const m of itemList(o.usingWeaponMods, ctx.quest)) add("gear", m.name, 1, "weapon-mod", m.id);
    for (const w of itemList(o.wearing, ctx.quest)) add("gear", w.name, 1, slotForName(w.name), w.id);
    for (const nw of itemList(o.notWearing, ctx.quest)) restrictions.push({ kind:"not-wearing", name:nw.name, itemId:nw.id, slot:slotForName(nw.name), sourceObjective:text });

    for (const w of inferWeapon(text)) add("gear", w, 1, "weapon");

    if (o.foundInRaid || o.fir || o.foundInRaidOnly) {
      for (const x of [...itemList(o.item,ctx.quest), ...itemList(o.items,ctx.quest)]) {
        if (x.name) fir.push({ name:x.name, qty:qty(o), itemId:x.id, sourceObjective:text });
      }
    }
    return { text, rawType, maps:objectiveMaps, category:category(o), requirements, restrictions, fir };
  });

  // If the upstream task exposes one fixed task map but the objectives omit maps,
  // use that fixed task map only for objectives already known to require a raid.
  const taskFallbackMap=(tm && tm!==RAID_MAP_ANY)?tm:"";
  if(taskFallbackMap && !objectiveRecords.some(o=>specificMaps(o.maps).length)){
    objectiveRecords=objectiveRecords.map(o=>{
      const first=finalizeObjectiveRaid(o);
      return first.raidRequired?finalizeObjectiveRaid({...o,maps:[taskFallbackMap]}):first;
    });
  }
  const raidMeta=taskRaidMeta(objectiveRecords);
  objectiveRecords=raidMeta.objectiveRecords;
  maps=raidMeta.mapBoundMaps.length?raidMeta.mapBoundMaps:(raidMeta.hasAnyRaidObjectives?[RAID_MAP_ANY]:[]);

  return {
    id:idOf(t), name:clean(t.name), trader:name(t.trader,ctx.traders)||"Unknown",
    maps, minLevel:Number(t.minPlayerLevel||0)||0, wikiLink:clean(t.wikiLink||""),
    taskRequirements:normalizeTaskRequirements(t),
    objectiveRecords,
    raidRelevant:raidMeta.raidRelevant,raidClass:raidMeta.raidClass,
    mapBoundMaps:raidMeta.mapBoundMaps,hasAnyRaidObjectives:raidMeta.hasAnyRaidObjectives,
    source:"json.tarkov.dev"
  };
}

// ---------- Wiki validation ----------

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi," ")
    .replace(/&amp;/gi,"&")
    .replace(/&quot;/gi,'"')
    .replace(/&#39;|&apos;/gi,"'")
    .replace(/&lt;/gi,"<")
    .replace(/&gt;/gi,">")
    .replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n)));
}
function stripTags(s) {
  return clean(decodeEntities(String(s)
    .replace(/<br\s*\/?>/gi," ")
    .replace(/<[^>]*>/g," ")));
}
function wikiTitle(name) {
  return name.replace(/\s+/g,"_");
}
function wikiPageCandidate(task){
  if(task.wikiLink){
    try{
      const u=new URL(task.wikiLink);
      const part=u.pathname.split("/wiki/")[1];
      if(part)return decodeURIComponent(part).replace(/_/g," ");
    }catch(e){}
  }
  return task.name.replace(/\s*\[PVP ZONE\]\s*$/i,"").trim();
}
async function fetchWikiPage(task) {
  const pageName=wikiPageCandidate(task);
  const params = new URLSearchParams({
    action:"parse", format:"json", origin:"*",
    page:pageName, prop:"text|revid", redirects:"1"
  });
  const r = await fetch(`${FANDOM_API}?${params}`, { headers:{ "User-Agent":"RaidPlan/1.0 task-validation" }});
  if (!r.ok) throw new Error(`wiki ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.info || "wiki parse error");
  return { html:j.parse?.text?.["*"] || "", revid:j.parse?.revid || null, title:j.parse?.title || pageName };
}
function extractObjectivesSection(html) {
  // Find the Objectives heading and stop at the next h2.
  const marker = /<span[^>]+id=["']Objectives["'][^>]*>/i.exec(html);
  if (!marker) return null;
  const start = marker.index;
  const rest = html.slice(start);
  const next = /<h2\b/i.exec(rest.slice(marker[0].length));
  const section = next ? rest.slice(0, marker[0].length + next.index) : rest.slice(0, 12000);

  // Keep top-level/visible list items. Nested Optional lines may appear too; they are retained
  // but won't match structured mandatory objectives unless text similarity is high.
  const current = [], removed = [];
  const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liRe.exec(section))) {
    const raw = m[1];
    const text = stripTags(raw);
    if (!text || text.length < 3) continue;
    const struck = /<(?:s|strike|del)\b/i.test(raw) || /text-decoration\s*:\s*line-through/i.test(raw);
    (struck ? removed : current).push(text);
  }
  return { current:uniq(current), removed:uniq(removed) };
}
function normObjective(s) {
  return clean(s)
    .toLowerCase()
    .replace(/[×x]\s*\d+/g," ")
    .replace(/\b\d+\b/g," ")
    .replace(/\([^)]*\)/g," ")
    .replace(/[^a-z0-9]+/g," ")
    .replace(/\b(?:the|a|an|to|of|on|at|in|and|with|while|from|location)\b/g," ")
    .replace(/\s+/g," ").trim();
}
function tokenSet(s) { return new Set(normObjective(s).split(" ").filter(x=>x.length>2)); }
function similarity(a,b) {
  const A=tokenSet(a),B=tokenSet(b);
  if (!A.size || !B.size) return 0;
  let hit=0; for (const x of A) if (B.has(x)) hit++;
  return hit / Math.max(A.size,B.size);
}
function bestMatch(text, candidates) {
  let best=null,score=0;
  for (const c of candidates) {
    const s=similarity(text,c);
    if (s>score){score=s;best=c}
  }
  return { text:best, score };
}

const CURRENT_MAP_NAMES=[
  "Ground Zero 21+","Ground Zero","Streets of Tarkov","The Labyrinth","The Lab",
  "Night Factory","Factory","Customs","Shoreline","Reserve","Woods",
  "Interchange","Lighthouse","Icebreaker"
];

function cleanWikiObjectiveText(value){
  let s=clean(value);
  // Fandom nested optional hints can get flattened into the parent <li>.
  // Keep the actual objective and discard the appended optional hint.
  s=s.replace(/\s*\(\s*Optional\s*\)\s*.*$/i,"").trim();
  return s;
}
function inferMapsFromText(value){
  const s=clean(value);
  const found=[];
  for(const map of CURRENT_MAP_NAMES){
    const re=new RegExp(`\\b${map.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}\\b`,"i");
    if(re.test(s))found.push(map);
  }
  if(/\bany location\b/i.test(s))found.push("Any");
  return uniq(found);
}
function inferWearingFromText(value){
  const s=clean(value);
  const m=s.match(/\bwhile wearing\s+(.+?)(?=\s+(?:on|at|in|while|during|and eliminating|and kill)\b|[,.;]|$)/i);
  if(!m)return [];
  return m[1].split(/\s+(?:and|&)\s+/i).map(tidyGearPhrase).filter(Boolean);
}
function inferNotWearingFromText(value){
  const s=clean(value);
  const m=s.match(/\b(?:without wearing|while not wearing|not wearing)\s+(.+?)(?=\s+(?:on|at|in|while|during)\b|[,.;]|$)/i);
  if(!m)return [];
  return m[1].split(/\s+(?:and|&)\s+/i).map(tidyGearPhrase).filter(Boolean);
}
function inferRequirementsFromCurrentText(value){
  const requirements=[],restrictions=[];
  const text=cleanWikiObjectiveText(value);
  const add=(kind,name,qty=1,slot=null,itemId="")=>{
    name=clean(name); if(!name)return;
    requirements.push({kind,name,qty:Number(qty)||1,slot,itemId,sourceObjective:text});
  };

  const marker=inferMarker(text);
  if(marker)add("item",marker.name,marker.qty);

  for(const weapon of inferWeapon(text))add("gear",weapon,1,"weapon");
  for(const worn of inferWearingFromText(text))add("gear",worn,1,slotForName(worn));
  for(const excluded of inferNotWearingFromText(text)){
    restrictions.push({kind:"not-wearing",name:excluded,itemId:"",slot:slotForName(excluded),sourceObjective:text});
  }
  return {requirements,restrictions,fir:[]};
}
function mergeRecordsByKey(records){
  const out=[],seen=new Set();
  for(const r of records){
    const k=[r.kind,r.name,r.slot||"",r.itemId||""].join("|").toLowerCase();
    if(seen.has(k))continue;
    seen.add(k);out.push(r);
  }
  return out;
}

function isConsumablePlacementRequirement(r){
  if(r?.kind!=="item")return false;
  const n=clean(r.name).toLowerCase();
  const objective=clean(r.sourceObjective||"");
  return /marker|camera|jammer|beacon|transmitter|repeater|device/i.test(n)
    || /\b(?:mark|plant|place|stash|hide|install|leave|deposit)\b/i.test(objective);
}
function mergeTaskRequirements(records){
  const grouped=new Map();
  for(const r of records){
    const k=[r.kind,r.name,r.slot||"",r.itemId||""].join("|").toLowerCase();
    if(!grouped.has(k))grouped.set(k,[]);
    grouped.get(k).push(r);
  }
  const out=[];
  for(const rows of grouped.values()){
    const first={...rows[0]};
    if(isConsumablePlacementRequirement(first)){
      // Each placement objective consumes its own item. Rows have already been
      // deduplicated inside each objective, so summing here represents the raid total.
      first.qty=rows.reduce((n,r)=>n+(Number(r.qty)||1),0);
    }else{
      // Reusable gear/keys should not multiply just because multiple objectives mention them.
      first.qty=Math.max(...rows.map(r=>Number(r.qty)||1));
    }
    out.push(first);
  }
  return out;
}

function applyWikiValidation(task, wiki) {
  const parsed=extractObjectivesSection(wiki.html);
  if(!parsed || !parsed.current.length){
    return {task,status:"unparsed",removed:[],mismatches:[],wikiCurrent:[],wikiRemoved:[]};
  }

  const currentWiki=uniq(parsed.current.map(cleanWikiObjectiveText).filter(Boolean));
  const removedWiki=uniq(parsed.removed.map(cleanWikiObjectiveText).filter(Boolean));

  // Explicit strike-throughs are authoritative removals.
  const removed=[];
  for(const obj of task.objectiveRecords){
    const removedMatch=bestMatch(obj.text,removedWiki);
    if(removedMatch.score>=0.52){
      removed.push({
        source:obj.text,wiki:removedMatch.text,
        reason:"struck-on-wiki",score:removedMatch.score
      });
    }
  }

  // The CURRENT Wiki objective list is authoritative for visible objectives.
  // Attach structured source metadata only when it still matches strongly.
  const finalRecords=[];
  const mismatches=[];

  for(const wikiText of currentWiki){
    let bestSource=null,bestScore=0;
    for(const source of task.objectiveRecords){
      // Do not reattach metadata from an explicitly removed objective.
      if(removed.some(r=>r.source===source.text))continue;
      const score=similarity(source.text,wikiText);
      if(score>bestScore){bestScore=score;bestSource=source}
    }

    const inferred=inferRequirementsFromCurrentText(wikiText);
    let requirements=[...inferred.requirements];
    let restrictions=[...inferred.restrictions];
    let fir=[...inferred.fir];

    // Strong matches may safely retain structured item/key/FIR metadata.
    // Weak matches mean the quest changed: discard stale metadata and use Wiki text inference.
    if(bestSource && bestScore>=0.65){
      requirements.push(...(bestSource.requirements||[]).map(r=>({...r,sourceObjective:wikiText})));
      restrictions.push(...(bestSource.restrictions||[]).map(r=>({...r,sourceObjective:wikiText})));
      fir.push(...(bestSource.fir||[]).map(r=>({...r,sourceObjective:wikiText})));
    }else if(bestSource){
      mismatches.push({source:bestSource.text,wiki:wikiText,score:bestScore});
    }

    requirements=mergeRecordsByKey(requirements);
    restrictions=mergeRecordsByKey(restrictions);

    const inferredMaps=specificMaps(inferMapsFromText(wikiText));
    const sourceMaps=(bestSource && bestScore>=0.65)?specificMaps(bestSource.maps):[];
    finalRecords.push(finalizeObjectiveRaid({
      text:wikiText,
      rawType:bestSource?.rawType||"",
      maps:inferredMaps.length?inferredMaps:sourceMaps,
      category:category({description:wikiText}),
      requirements,restrictions,fir
    }));
  }

  const raidMeta=taskRaidMeta(finalRecords);
  const classifiedRecords=raidMeta.objectiveRecords;
  const finalMaps=raidMeta.mapBoundMaps.length?raidMeta.mapBoundMaps:(raidMeta.hasAnyRaidObjectives?[RAID_MAP_ANY]:[]);

  const cats=uniq(classifiedRecords.map(x=>x.category).filter(x=>x!=="Other"));
  const requirements=[],restrictions=[],fir=[];
  for(const o of classifiedRecords){
    requirements.push(...o.requirements);
    restrictions.push(...o.restrictions);
    fir.push(...o.fir);
  }

  const finalTask={
    id:task.id,name:task.name,trader:task.trader,maps:finalMaps,
    type:cats.length?cats.slice(0,3).join(" / "):"Other",
    objectives:classifiedRecords.map(o=>o.text),
    objectiveDetails:publicObjectiveDetails(classifiedRecords),
    requirements:mergeTaskRequirements(requirements),
    restrictions:mergeRecordsByKey(restrictions),
    fir,
    minLevel:task.minLevel,wikiLink:task.wikiLink,
    taskRequirements:task.taskRequirements||[],
    raidRelevant:raidMeta.raidRelevant,raidClass:raidMeta.raidClass,
    mapBoundMaps:raidMeta.mapBoundMaps,hasAnyRaidObjectives:raidMeta.hasAnyRaidObjectives,
    source:"json.tarkov.dev + Tarkov Wiki",
    wikiRevision:wiki.revid
  };

  return {
    task:finalTask,status:"validated",removed,mismatches,
    wikiCurrent:currentWiki,wikiRemoved:removedWiki
  };
}
async function pooled(items, worker, concurrency=5) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try { results[i] = await worker(items[i], i); }
      catch (e) { results[i] = { error:String(e?.message || e) }; }
      await sleep(REQUEST_DELAY_MS);
    }
  }
  await Promise.all(Array.from({length:concurrency},run));
  return results;
}

// ---------- Automated data QA ----------

function runDataQA(allTasks, raidTasks, nonRaidTasks) {
  const issues=[];
  let checkCount=0;
  const add=(severity,code,task,message,details={})=>issues.push({severity,code,task:task||null,message,...details});
  const check=(condition,severity,code,task,message,details={})=>{
    checkCount++;
    if(!condition)add(severity,code,task,message,details);
  };

  const allById=new Map(allTasks.map(t=>[t.id,t]));
  const raidByName=new Map(raidTasks.map(t=>[t.name,t]));
  const ids=allTasks.map(t=>t.id);
  check(new Set(ids).size===ids.length,"critical","DUPLICATE_TASK_ID",null,"Task IDs must be unique.");

  for(const t of raidTasks){
    check(!!t.raidRelevant,"critical","NON_RAID_IN_RAID_POOL",t.name,"Raid task pool contains a task classified as non-raid.");
    check((t.objectiveDetails||[]).some(o=>o.raidRequired!==false),"critical","NO_RAID_OBJECTIVE",t.name,"Raid-plannable task has no raid-required objective.");

    if(t.raidClass==="MAP_BOUND"){
      check(Array.isArray(t.mapBoundMaps)&&t.mapBoundMaps.length>0,"critical","MAP_BOUND_WITHOUT_MAP",t.name,"MAP_BOUND task has no committed map metadata.");
      check((t.objectiveDetails||[]).some(o=>o.raidClass==="MAP_BOUND"&&(o.maps||[]).length),"critical","MAP_OBJECTIVE_WITHOUT_MAP",t.name,"MAP_BOUND task has no map-bound objective with a map.");
    }
    if(t.raidClass==="ANY_RAID"){
      check((t.objectiveDetails||[]).some(o=>o.raidClass==="ANY_RAID"),"critical","ANY_RAID_WITHOUT_OBJECTIVE",t.name,"ANY_RAID task has no ANY_RAID objective.");
    }

    check(!/^Gunsmith\s*-/i.test(t.name),"critical","GUNSMITH_IN_RAID_POOL",t.name,"Gunsmith tasks must not be raid-plannable.");

    const weaponObjectives=(t.objectives||[]).flatMap(text=>inferWeapon(text).map(name=>({text,name})));
    if(weaponObjectives.length){
      const weaponReq=(t.requirements||[]).filter(r=>r.kind==="gear"&&r.slot==="weapon");
      check(weaponReq.length>0,"critical","MISSING_WEAPON_REQUIREMENT",t.name,"Weapon-restricted objective has no weapon requirement.",{objectives:weaponObjectives});
    }

    const markerObjectives=(t.objectives||[]).filter(text=>/\bmark\b/i.test(text)&&/\bMS2000\s+Marker\b/i.test(text));
    if(markerObjectives.length){
      const markerQty=(t.requirements||[])
        .filter(r=>clean(r.name).toLowerCase()==="ms2000 marker")
        .reduce((n,r)=>n+(Number(r.qty)||1),0);
      check(markerQty>=markerObjectives.length,"critical","MARKER_QUANTITY_UNDERCOUNT",t.name,`Task has ${markerObjectives.length} MS2000 placement objectives but only ${markerQty} marker quantity in requirements.`);
    }

    for(const r of (t.requirements||[])){
      const source=clean(r.sourceObjective);
      if(/^K-\d/i.test(clean(r.name))&&/\bAK-\d/i.test(source)){
        check(false,"critical","TRUNCATED_AK_REQUIREMENT",t.name,`Weapon requirement "${r.name}" appears to have lost the leading A from AK-.`,{sourceObjective:source});
      }
    }

    for(const r of (t.taskRequirements||[])){
      check(allById.has(r.taskId),"warning","ORPHAN_PREREQUISITE",t.name,`Prerequisite ID ${r.taskId} is missing from the dependency catalogue.`);
    }
  }

  const visiting=new Set(),visited=new Set(),cyclePaths=[];
  function dfs(id,path=[]){
    if(visiting.has(id)){cyclePaths.push([...path,id]);return}
    if(visited.has(id))return;
    visiting.add(id);
    const t=allById.get(id);
    for(const r of (t?.taskRequirements||[])){
      const statuses=(r.statuses||[]).map(x=>clean(x).toLowerCase());
      if(statuses.some(x=>x.includes("complete")))dfs(r.taskId,[...path,id]);
    }
    visiting.delete(id);visited.add(id);
  }
  for(const id of allById.keys())dfs(id);
  check(cyclePaths.length===0,"warning","PREREQUISITE_CYCLE",null,"Quest prerequisite graph contains a cycle.",{cycles:cyclePaths.slice(0,5)});

  const human=raidByName.get("Humanitarian Supplies");
  if(human){
    check(!(human.objectives||[]).some(x=>/wearing a UN uniform|MF-UNTAR body armor.*UNTAR helmet/i.test(x)),
      "critical","REGRESSION_HUMANITARIAN_STALE_UNIFORM",human.name,"Removed Humanitarian Supplies UN-uniform objective has returned.");
  }

  const peace=raidByName.get("Peacekeeping Mission");
  if(peace&&(peace.objectives||[]).some(x=>/5\.56\s+UN weapons/i.test(x))){
    check((peace.requirements||[]).some(r=>r.slot==="weapon"&&/5\.56\s+UN weapons/i.test(r.name)),
      "critical","REGRESSION_PEACEKEEPING_WEAPON",peace.name,"Peacekeeping Mission is missing its 5.56 UN weapon requirement.");
  }

  const punisher=raidByName.get("The Punisher - Part 2");
  if(punisher&&(punisher.objectives||[]).some(x=>/AKM series weapon/i.test(x))){
    check((punisher.requirements||[]).some(r=>r.slot==="weapon"&&/AKM series weapon/i.test(r.name)),
      "critical","REGRESSION_PUNISHER_AKM",punisher.name,"Punisher Part 2 is missing its AKM-series weapon requirement.");
  }

  const revision=raidByName.get("Revision - Reserve")||raidByName.get("Revision");
  if(revision){
    const count=(revision.objectives||[]).filter(x=>/\bmark\b/i.test(x)&&/MS2000/i.test(x)).length;
    if(count){
      const qty=(revision.requirements||[]).filter(r=>/MS2000 Marker/i.test(r.name)).reduce((n,r)=>n+(Number(r.qty)||1),0);
      check(qty>=count,"critical","REGRESSION_REVISION_MARKERS",revision.name,`Revision requires ${count} marker placements but only ${qty} markers were generated.`);
    }
  }

  const hot=raidByName.get("Hot Wheels");
  if(hot&&(hot.objectives||[]).some(x=>/MS2000/i.test(x))){
    check((hot.requirements||[]).some(r=>/MS2000 Marker/i.test(r.name)),
      "critical","REGRESSION_HOT_WHEELS_MARKER",hot.name,"Hot Wheels is missing its MS2000 Marker requirement.");
  }

  const bestJob=raidByName.get("Best Job in the World");
  if(bestJob&&(bestJob.objectives||[]).some(x=>/AK-74 series weapons/i.test(x))){
    check((bestJob.requirements||[]).some(r=>r.slot==="weapon"&&/AK-74 series weapons/i.test(r.name)),
      "critical","REGRESSION_AK74_TRUNCATION",bestJob.name,"Best Job in the World should retain the full AK-74 weapon-family name.");
  }

  const critical=issues.filter(x=>x.severity==="critical");
  const warnings=issues.filter(x=>x.severity==="warning");
  return {status:critical.length?"fail":warnings.length?"review":"pass",checkCount,criticalCount:critical.length,warningCount:warnings.length,issues};
}

// ---------- Run ----------

console.log("RaidIQ sync: loading json.tarkov.dev…");
const [td,md,rd]=await Promise.all([translated("tasks"),translated("maps"),translated("traders")]);
const ctx={quest:lookup(td,"questItems"),maps:lookup(md,"maps"),traders:lookup(rd,"traders")};
const rawTasks=arr(td.tasks).map(t=>normalizeTask(t,ctx)).filter(t=>t.id&&t.name);

console.log(`Structured tasks loaded: ${rawTasks.length}`);
console.log("Validating quest pages against the Tarkov Wiki…");

const validated = await pooled(rawTasks, async task => {
  const wiki = await fetchWikiPage(task);
  const result = applyWikiValidation(task,wiki);
  return {...result,wikiTitle:wiki.title,revid:wiki.revid};
}, CONCURRENCY);

const allFinalTasks=[], audit=[];
for (let i=0;i<rawTasks.length;i++) {
  const original=rawTasks[i],r=validated[i];
  if (!r || r.error) {
    // Conservative fallback: retain upstream task if wiki validation failed.
    const req=[],res=[],fir=[];
    const fallbackMeta=taskRaidMeta(original.objectiveRecords);
    for(const o of fallbackMeta.objectiveRecords){req.push(...o.requirements);res.push(...o.restrictions);fir.push(...o.fir)}
    const cats=uniq(fallbackMeta.objectiveRecords.map(o=>o.category).filter(x=>x!=="Other"));
    allFinalTasks.push({
      id:original.id,name:original.name,trader:original.trader,
      maps:fallbackMeta.mapBoundMaps.length?fallbackMeta.mapBoundMaps:(fallbackMeta.hasAnyRaidObjectives?[RAID_MAP_ANY]:[]),
      type:cats.slice(0,3).join(" / ")||"Other",
      objectives:fallbackMeta.objectiveRecords.map(o=>o.text),
      objectiveDetails:publicObjectiveDetails(fallbackMeta.objectiveRecords),
      requirements:mergeTaskRequirements(req),restrictions:res,fir,minLevel:original.minLevel,wikiLink:original.wikiLink,
      taskRequirements:original.taskRequirements||[],
      raidRelevant:fallbackMeta.raidRelevant,raidClass:fallbackMeta.raidClass,
      mapBoundMaps:fallbackMeta.mapBoundMaps,hasAnyRaidObjectives:fallbackMeta.hasAnyRaidObjectives,
      source:"json.tarkov.dev (wiki validation unavailable)"
    });
    audit.push({task:original.name,status:"wiki-error",error:r?.error||"unknown"});
  } else {
    allFinalTasks.push(r.task);
    audit.push({
      task:original.name,status:r.status,wikiTitle:r.wikiTitle,revid:r.revid,
      removedObjectives:r.removed,
      wordingMismatches:r.mismatches||[],
      struckObjectives:r.wikiRemoved
    });
  }
}

const nonRaidTasks=allFinalTasks.filter(t=>!t.raidRelevant);
const finalTasks=allFinalTasks.filter(t=>t.raidRelevant);
const dependencyCatalog=Object.fromEntries(allFinalTasks.map(t=>[t.id,{
  name:t.name,
  raidRelevant:!!t.raidRelevant,
  taskRequirements:t.taskRequirements||[]
}]));
finalTasks.sort((a,b)=>a.trader.localeCompare(b.trader)||a.name.localeCompare(b.name));

const qa=runDataQA(allFinalTasks,finalTasks,nonRaidTasks);
console.log(`Automated QA: ${qa.status.toUpperCase()} · ${qa.checkCount} checks · ${qa.criticalCount} critical · ${qa.warningCount} warnings`);
for(const issue of qa.issues.slice(0,25)){
  console.log(`[QA ${issue.severity.toUpperCase()}] ${issue.code}${issue.task?` · ${issue.task}`:""}: ${issue.message}`);
}

const generatedAt=new Date().toISOString();
await writeFile("tasks.snapshot.json",JSON.stringify({
  generatedAt,
  mode:MODE,
  sources:["json.tarkov.dev","escapefromtarkov.fandom.com"],
  taskCount:finalTasks.length,
  excludedNonRaidCount:nonRaidTasks.length,
  qa:{status:qa.status,checkCount:qa.checkCount,criticalCount:qa.criticalCount,warningCount:qa.warningCount},
  dependencyCatalog,
  tasks:finalTasks
},null,2));

const changed=audit.filter(x=>x.removedObjectives?.length);
const wikiErrors=audit.filter(x=>x.status==="wiki-error");
const unparsed=audit.filter(x=>x.status==="unparsed");

await writeFile("data-audit.json",JSON.stringify({
  generatedAt,
  summary:{
    tasks:finalTasks.length,
    tasksWithCorrections:changed.length,
    removedObjectives:changed.reduce((n,x)=>n+x.removedObjectives.length,0),
    wordingMismatches:audit.reduce((n,x)=>n+(x.wordingMismatches?.length||0),0),
    wikiErrors:wikiErrors.length,
    unparsedWikiPages:unparsed.length,
    excludedNonRaidTasks:nonRaidTasks.length,
    mapBoundTasks:finalTasks.filter(t=>t.raidClass==="MAP_BOUND").length,
    anyRaidTasks:finalTasks.filter(t=>t.raidClass==="ANY_RAID").length,
    qaStatus:qa.status,
    qaChecks:qa.checkCount,
    qaCritical:qa.criticalCount,
    qaWarnings:qa.warningCount
  },
  qa,
  excludedNonRaid:nonRaidTasks.map(t=>({id:t.id,name:t.name,trader:t.trader})),
  corrections:changed,
  wikiErrors,
  unparsed
},null,2));

console.log("");
console.log("RaidIQ data sync complete");
console.log(`Raid-plannable tasks: ${finalTasks.length}`);
console.log(`Excluded non-raid tasks: ${nonRaidTasks.length}`);
console.log(`Tasks corrected by Wiki: ${changed.length}`);
console.log(`Objectives removed as stale/struck: ${changed.reduce((n,x)=>n+x.removedObjectives.length,0)}`);
console.log(`Wiki errors: ${wikiErrors.length}`);
console.log(`Unparsed pages: ${unparsed.length}`);
console.log(`QA checks: ${qa.checkCount} · critical: ${qa.criticalCount} · warnings: ${qa.warningCount}`);
console.log("Wrote tasks.snapshot.json and data-audit.json");
if(qa.criticalCount){
  throw new Error(`RaidIQ data QA failed with ${qa.criticalCount} critical issue${qa.criticalCount!==1?"s":""}. Refusing to publish this refresh.`);
}
