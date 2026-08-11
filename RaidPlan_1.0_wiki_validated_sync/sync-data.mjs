// RaidPlan 1.0 data synchroniser
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
    /\bwhile using\s+(?:an?|the|any)?\s*([^,.;]+?)(?=\s+(?:on|at|in|from|while|without|during)\b|[,.;]|$)/ig,
    /\busing\s+(?:an?|the|any)?\s*([^,.;]+?)(?=\s+(?:on|at|in|from|while|without|during)\b|[,.;]|$)/ig,
    /\bwith\s+(?:an?|the|any)?\s*([^,.;]+?(?:weapon(?:s)?|rifle(?:s)?|shotgun(?:s)?|pistol(?:s)?|smg(?:s)?|carbine(?:s)?|sniper rifle(?:s)?|assault rifle(?:s)?|marksman rifle(?:s)?|machine gun(?:s)?))(?=\s+(?:on|at|in|from|while|during)\b|[,.;]|$)/ig
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(d))) {
      const p = tidyGearPhrase(m[1]);
      if (looksWeapon(p)) out.push(p);
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
function normalizeTask(t, ctx) {
  const os = arr(t.objectives);
  const tm = name(t.map, ctx.maps);
  let maps = uniq([tm, ...os.flatMap(o => mapNames(o, ctx.maps))]);
  if (!maps.length) maps = ["Any"];

  const objectiveRecords = os.map(o => {
    const text = objectiveText(o);
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
    return { text, category:category(o), requirements, restrictions, fir };
  });

  return {
    id:idOf(t), name:clean(t.name), trader:name(t.trader,ctx.traders)||"Unknown",
    maps, minLevel:Number(t.minPlayerLevel||0)||0, wikiLink:clean(t.wikiLink||""),
    objectiveRecords, source:"json.tarkov.dev"
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
async function fetchWikiPage(taskName) {
  const params = new URLSearchParams({
    action:"parse", format:"json", origin:"*",
    page:taskName, prop:"text|revid", redirects:"1"
  });
  const r = await fetch(`${FANDOM_API}?${params}`, { headers:{ "User-Agent":"RaidPlan/1.0 task-validation" }});
  if (!r.ok) throw new Error(`wiki ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.info || "wiki parse error");
  return { html:j.parse?.text?.["*"] || "", revid:j.parse?.revid || null, title:j.parse?.title || taskName };
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
function applyWikiValidation(task, wiki) {
  const parsed = extractObjectivesSection(wiki.html);
  if (!parsed || !parsed.current.length) {
    return { task, status:"unparsed", removed:[], wikiCurrent:[], wikiRemoved:[] };
  }

  const kept=[], removed=[];
  for (const obj of task.objectiveRecords) {
    const currentMatch=bestMatch(obj.text, parsed.current);
    const removedMatch=bestMatch(obj.text, parsed.removed);

    // Explicit strike-through wins when it matches reasonably well.
    if (removedMatch.score >= 0.52 && removedMatch.score >= currentMatch.score) {
      removed.push({source:obj.text,wiki:removedMatch.text,reason:"struck-on-wiki",score:removedMatch.score});
      continue;
    }

    // If the wiki objective list is clearly available, require a reasonable match.
    // This removes stale structured objectives which no longer exist in the current page.
    if (currentMatch.score >= 0.45) {
      kept.push({...obj, text:currentMatch.text || obj.text});
      continue;
    }

    // Avoid deleting generic survival/optional objectives too aggressively.
    if (obj.category==="Survive" || /^optional\b/i.test(obj.text)) {
      kept.push(obj);
      continue;
    }

    removed.push({source:obj.text,wiki:null,reason:"not-present-in-current-wiki-objectives",score:currentMatch.score});
  }

  const cats=uniq(kept.map(x=>x.category).filter(x=>x!=="Other"));
  const requirements=[],restrictions=[],fir=[];
  for (const o of kept) {
    requirements.push(...o.requirements);
    restrictions.push(...o.restrictions);
    fir.push(...o.fir);
  }

  const finalTask={
    id:task.id,name:task.name,trader:task.trader,maps:task.maps,
    type:cats.length?cats.slice(0,3).join(" / "):"Other",
    objectives:kept.map(o=>o.text),
    requirements,restrictions,fir,
    minLevel:task.minLevel,wikiLink:task.wikiLink,
    source:"json.tarkov.dev + Tarkov Wiki",
    wikiRevision:wiki.revid
  };
  return { task:finalTask,status:"validated",removed,wikiCurrent:parsed.current,wikiRemoved:parsed.removed };
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

// ---------- Run ----------

console.log("RaidPlan sync: loading json.tarkov.dev…");
const [td,md,rd]=await Promise.all([translated("tasks"),translated("maps"),translated("traders")]);
const ctx={quest:lookup(td,"questItems"),maps:lookup(md,"maps"),traders:lookup(rd,"traders")};
const rawTasks=arr(td.tasks).map(t=>normalizeTask(t,ctx)).filter(t=>t.id&&t.name);

console.log(`Structured tasks loaded: ${rawTasks.length}`);
console.log("Validating quest pages against the Tarkov Wiki…");

const validated = await pooled(rawTasks, async task => {
  const wiki = await fetchWikiPage(task.name);
  const result = applyWikiValidation(task,wiki);
  return {...result,wikiTitle:wiki.title,revid:wiki.revid};
}, CONCURRENCY);

const finalTasks=[], audit=[];
for (let i=0;i<rawTasks.length;i++) {
  const original=rawTasks[i],r=validated[i];
  if (!r || r.error) {
    // Conservative fallback: retain upstream task if wiki validation failed.
    const req=[],res=[],fir=[];
    for(const o of original.objectiveRecords){req.push(...o.requirements);res.push(...o.restrictions);fir.push(...o.fir)}
    const cats=uniq(original.objectiveRecords.map(o=>o.category).filter(x=>x!=="Other"));
    finalTasks.push({
      id:original.id,name:original.name,trader:original.trader,maps:original.maps,
      type:cats.slice(0,3).join(" / ")||"Other",
      objectives:original.objectiveRecords.map(o=>o.text),
      requirements:req,restrictions:res,fir,minLevel:original.minLevel,wikiLink:original.wikiLink,
      source:"json.tarkov.dev (wiki validation unavailable)"
    });
    audit.push({task:original.name,status:"wiki-error",error:r?.error||"unknown"});
  } else {
    finalTasks.push(r.task);
    audit.push({
      task:original.name,status:r.status,wikiTitle:r.wikiTitle,revid:r.revid,
      removedObjectives:r.removed,
      struckObjectives:r.wikiRemoved
    });
  }
}

finalTasks.sort((a,b)=>a.trader.localeCompare(b.trader)||a.name.localeCompare(b.name));

const generatedAt=new Date().toISOString();
await writeFile("tasks.snapshot.json",JSON.stringify({
  generatedAt,
  mode:MODE,
  sources:["json.tarkov.dev","escapefromtarkov.fandom.com"],
  taskCount:finalTasks.length,
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
    wikiErrors:wikiErrors.length,
    unparsedWikiPages:unparsed.length
  },
  corrections:changed,
  wikiErrors,
  unparsed
},null,2));

console.log("");
console.log("RaidPlan data sync complete");
console.log(`Tasks: ${finalTasks.length}`);
console.log(`Tasks corrected by Wiki: ${changed.length}`);
console.log(`Objectives removed as stale/struck: ${changed.reduce((n,x)=>n+x.removedObjectives.length,0)}`);
console.log(`Wiki errors: ${wikiErrors.length}`);
console.log(`Unparsed pages: ${unparsed.length}`);
console.log("Wrote tasks.snapshot.json and data-audit.json");
