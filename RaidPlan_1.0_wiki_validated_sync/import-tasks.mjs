// RaidPlan task snapshot importer
// Node 18+ / Node 20+
// Usage: node import-tasks.mjs
import { writeFile } from "node:fs/promises";

const BASE="https://json.tarkov.dev";
const MODE="regular";
const arr=v=>Array.isArray(v)?v:(v&&typeof v==="object"?Object.values(v):[]);
const idOf=v=>typeof v==="string"?v:(v&&typeof v==="object"?(v.id||v._id||""):"");
const clean=s=>String(s??"").trim();
const uniq=a=>[...new Set(a.filter(Boolean))];

function parsePath(path){
 if(typeof path!=="string"||!path.startsWith("$."))return null;
 return path.slice(2).split(".").map(part=>part==="*"?{kind:"wild"}:part.endsWith("[*]")?{kind:"array",key:part.slice(0,-3)}:{kind:"key",key:part});
}
function apply(root,steps,dict,i=0){
 if(root==null||typeof root!=="object"||i>=steps.length)return;
 const s=steps[i],last=i===steps.length-1;
 if(s.kind==="wild"){for(const k of Object.keys(root)){if(last){const v=root[k];if(typeof v==="string"&&dict[v]!==undefined)root[k]=dict[v]}else apply(root[k],steps,dict,i+1)}return}
 if(s.kind==="array"){const a=root[s.key];if(!Array.isArray(a))return;for(let k=0;k<a.length;k++){if(last){const v=a[k];if(typeof v==="string"&&dict[v]!==undefined)a[k]=dict[v]}else apply(a[k],steps,dict,i+1)}return}
 if(last){const v=root[s.key];if(typeof v==="string"&&dict[v]!==undefined)root[s.key]=dict[v]}else apply(root[s.key],steps,dict,i+1);
}
async function translated(endpoint){
 const [b,e]=await Promise.all([fetch(`${BASE}/${MODE}/${endpoint}`),fetch(`${BASE}/${MODE}/${endpoint}_en`)]);
 if(!b.ok)throw new Error(`${endpoint} ${b.status}`);
 const base=await b.json(),en=e.ok?await e.json():{data:{}},copy=structuredClone(base),dict=en.data||{};
 for(const p of copy.translations||[]){const steps=parsePath(p);if(steps)apply(copy,steps,dict)}
 return copy.data;
}
function lookup(data,key){const m=new Map();for(const x of arr(data?.[key]??data)){const id=idOf(x);if(id)m.set(id,x)}return m}
function obj(v,...ls){if(v&&typeof v==="object")return v;for(const l of ls){const x=l?.get(idOf(v));if(x)return x}return {id:idOf(v)}}
function name(v,...ls){const x=obj(v,...ls);return clean(x.name||x.shortName||x.normalizedName)}
function q(o){for(const n of [o?.count,o?.quantity,o?.requiredCount,o?.amount])if(Number(n)>0)return Number(n);return 1}
function mapsOf(o,maps){return uniq([...(arr(o.maps).map(x=>name(x,maps))),...(arr(o.zones).map(x=>name(x?.map,maps))),...(arr(o.possibleLocations).map(x=>name(x?.map,maps)))])}
function cat(o){const t=clean(o.type||o.__typename).toLowerCase(),d=clean(o.description||o.name||o.text).toLowerCase();if(o.markerItem||t.includes("mark")||d.includes("mark ")||d.includes("plant "))return"Place";if(o.usingWeapon||t.includes("kill")||d.includes("eliminate")||d.includes("kill "))return"Kill";if(o.item||o.items||o.questItem||t.includes("find")||t.includes("give")||d.includes("find ")||d.includes("hand over"))return"Find / Hand over";if(t.includes("visit")||d.includes("locate "))return"Locate";if(d.includes("survive")||d.includes("extract"))return"Survive";return"Other"}
function normalize(t,c){
 const os=arr(t.objectives),tm=name(t.map,c.maps);let maps=uniq([tm,...os.flatMap(o=>mapsOf(o,c.maps))]);if(!maps.length)maps=["Any"];
 const requirements=[],restrictions=[],fir=[];
 const add=(kind,n,qty=1,slot=null,id="")=>{n=clean(n);if(n)requirements.push({kind,name:n,qty,slot,itemId:id})};
 for(const o of os){
  for(const group of arr(o.requiredKeys)){const names=(Array.isArray(group)?group:[group]).map(x=>name(x,c.quest)).filter(Boolean);if(names.length)add("key",names.join(" OR "))}
  let structuredMarker=false;
  if(o.markerItem){
    const markerName=name(o.markerItem,c.quest);
    if(markerName){
      add("item",markerName,q(o),null,idOf(o.markerItem));
      structuredMarker=true;
    }
  }

  // Fallback for task feeds where the marker is present only in the objective text.
  if(!structuredMarker){
    const markerText=clean(o.description||o.name||o.text||"");
    if(/\bmark\b/i.test(markerText)&&/\bMS2000\s+Marker\b/i.test(markerText)){
      add("item","MS2000 Marker",1,null,"");
    }else{
      const mm=markerText.match(/\b(?:with|using)\s+(?:an?\s+)?([^,.;]*\bMarker\b)/i);
      if(mm)add("item",clean(mm[1]).replace(/^(?:an?|the|any)\s+/i,"").trim(),1,null,"");
    }
  }

  // usingWeapon can be a single reference or a list/group of references.
  for(const w of arr(o.usingWeapon))add("gear",name(w,c.quest),1,"weapon",idOf(w));
  if(o.usingWeapon&&!Array.isArray(o.usingWeapon))add("gear",name(o.usingWeapon,c.quest),1,"weapon",idOf(o.usingWeapon));
  for(const w of arr(o.wearing))add("gear",name(w,c.quest),1,null,idOf(w));

  // Text fallback: preserve explicit weapon requirements when upstream structured fields are absent.
  const text=clean(o.description||o.name||o.text||"");
  const patterns=[
    /\bwhile using\s+(?:an?|the|any)?\s*([^,.;]+?)(?=\s+(?:on|at|in|from|while|without|during)\b|[,.;]|$)/ig,
    /\busing\s+(?:an?|the|any)?\s*([^,.;]+?)(?=\s+(?:on|at|in|from|while|without|during)\b|[,.;]|$)/ig,
    /\bwith\s+(?:an?|the|any)?\s*([^,.;]+?(?:weapon(?:s)?|rifle(?:s)?|shotgun(?:s)?|pistol(?:s)?|smg(?:s)?|carbine(?:s)?|sniper rifle(?:s)?|assault rifle(?:s)?|marksman rifle(?:s)?|machine gun(?:s)?))(?=\s+(?:on|at|in|from|while|during)\b|[,.;]|$)/ig
  ];
  for(const re of patterns){
    let m;while((m=re.exec(text))){
      const phrase=clean(m[1]).replace(/^(?:an?|the|any)\s+/i,"").replace(/\s+(?:on|at|in)\s+(?:Customs|Shoreline|Reserve|Woods|Interchange|Factory|Lighthouse|Streets(?: of Tarkov)?|Ground Zero|The Lab|Labs)\b.*$/i,"").trim();
      if(/\b(?:weapon|weapons|rifle|rifles|shotgun|shotguns|pistol|pistols|smg|smgs|carbine|carbines|sniper|assault rifle|marksman rifle|machine gun|akm|ak-?\d|aks-?\d|svd|sv-?\d|m4a1|mp-?\d|vpo-?\d|suppressed)\b/i.test(phrase))add("gear",phrase,1,"weapon");
    }
  }
  for(const x of arr(o.notWearing))restrictions.push({kind:"not-wearing",name:name(x,c.quest),itemId:idOf(x)});
  if(o.foundInRaid||o.fir||o.foundInRaidOnly)for(const x of [...arr(o.items),...(o.item?[o.item]:[])])fir.push({name:name(x,c.quest),qty:q(o),itemId:idOf(x)});
 }
 return{id:idOf(t),name:clean(t.name),trader:name(t.trader,c.traders)||"Unknown",maps,type:uniq(os.map(cat).filter(x=>x!=="Other")).slice(0,3).join(" / ")||"Other",objectives:os.map(o=>clean(o.description||o.name||o.text||o.type)).filter(Boolean),requirements,restrictions,fir,minLevel:Number(t.minPlayerLevel||0)||0,wikiLink:clean(t.wikiLink),source:"json.tarkov.dev"};
}
const [td,md,rd]=await Promise.all([translated("tasks"),translated("maps"),translated("traders")]);
const c={quest:lookup(td,"questItems"),maps:lookup(md,"maps"),traders:lookup(rd,"traders")};
const tasks=arr(td.tasks).map(t=>normalize(t,c)).filter(t=>t.id&&t.name);
await writeFile("tasks.snapshot.json",JSON.stringify({generatedAt:new Date().toISOString(),source:"json.tarkov.dev/regular",tasks},null,2));
console.log(`RaidPlan snapshot written: ${tasks.length} tasks`);
