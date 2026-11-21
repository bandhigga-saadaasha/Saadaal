import {initializeApp,cert} from 'firebase-admin/app';
import {getFirestore,Timestamp} from 'firebase-admin/firestore';

initializeApp({credential:cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))});
const db=getFirestore();

const TZ=3*3600e3;            // waqtiga Soomaaliya/Itoobiya (GMT+3)
const day=864e5;
// Laba kooxood oo kala wakhti: Horyaalada (Sabti 00:00) iyo Champions League (Talaado 00:00)
const GROUPS=[
 {id:'league',prefix:'GW',startDow:6,startNo:3,leagues:{
   'eng.1':{name:'Premier League',must:['arsenal','manchester city','manchester united','liverpool','chelsea','brighton','tottenham']},
   'ita.1':{name:'Serie A',must:['milan','juventus','inter','roma','napoli','como','lazio','atalanta']},
   'esp.1':{name:'La Liga',must:['real madrid','barcelona','atletico madrid','real betis']}}},
 {id:'ucl',prefix:'UCL',startDow:2,startNo:1,leagues:{
   'uefa.champions':{name:'Champions League',must:['paris saint germain','real madrid','arsenal','liverpool','manchester city','bayern','manchester united','como','inter','atletico madrid']}}}
];
const FIX={'Internazionale':'Inter Milan','Bayern München':'Bayern Munich','AS Roma':'Roma'};
const norm=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/-/g,' ');
const fix=n=>FIX[n]||n;
const ymd=t=>new Date(t).toISOString().slice(0,10).replace(/-/g,'');

async function getEvents(slug,dates){
  const url=`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${dates}`;
  const r=await fetch(url,{headers:{'user-agent':'Mozilla/5.0','accept':'application/json'}});
  if(!r.ok){const t=(await r.text()).slice(0,150);throw new Error('HTTP '+r.status+' '+dates+' '+t)}
  return (await r.json()).events||[];
}
function parse(e){
  const c=e.competitions?.[0];if(!c)return null;
  const h=c.competitors.find(x=>x.homeAway==='home'),a=c.competitors.find(x=>x.homeAway==='away');
  if(!h||!a)return null;
  return {id:String(e.id),home:fix(h.team.displayName),away:fix(a.team.displayName),
    homeCrest:h.team.logo||'',awayCrest:a.team.logo||'',hc:h.team.abbreviation||'',ac:a.team.abbreviation||'',
    ms:new Date(e.date).getTime(),done:e.status?.type?.completed===true,hs:parseInt(h.score),as:parseInt(a.score)};
}
// bilowga todobaadka (00:00 GMT+3) ee maalinta startDow
function windowStart(startDow){
  const loc=new Date(Date.now()+TZ),back=(loc.getUTCDay()-startDow+7)%7;
  return Date.UTC(loc.getUTCFullYear(),loc.getUTCMonth(),loc.getUTCDate()-back)-TZ;
}

const stRef=db.doc('meta/state');
const st=(await stRef.get()).data()||{};
const gs=st.groups||{};
const known=new Map();   // dhammaan ciyaaraha la helay (natiijooyinka)
let errs=0,okAny=0;

for(const g of GROUPS){
  const start=windowStart(g.startDow),end=start+7*day;
  if(!gs[g.id]){gs[g.id]={anchor:start,startNo:g.startNo};await stRef.set({groups:{[g.id]:gs[g.id]}},{merge:true})}
  const week=g.prefix+(gs[g.id].startNo+Math.round((start-gs[g.id].anchor)/(7*day)));
  const cand=[];
  for(const [slug,L] of Object.entries(g.leagues)){
    let n=0,ok=0;
    for(let t=start-2*day;t<=end;t+=day){
      try{
        const ev=await getEvents(slug,ymd(t));ok++;
        for(const e of ev){
          const f=parse(e);if(!f)continue;
          f.league=L.name;known.set(f.id,f);n++;
          const inWin=f.ms>=start&&f.ms<end;
          const must=L.must.some(m=>norm(f.home).includes(m)||norm(f.away).includes(m));
          if(inWin&&must&&!cand.find(c=>c.id===f.id))cand.push(f);
        }
      }catch(err){errs++;console.log(L.name,ymd(t),err.message)}
    }
    if(ok)okAny++;
    console.log(g.id,L.name,'events:',n,'maalmo:',ok);
  }
  const ex=new Set((await db.collection('fixtures').where('week','==',week).get()).docs.map(d=>d.id));
  for(const c of cand){
    const base={home:c.home,away:c.away,homeCrest:c.homeCrest,awayCrest:c.awayCrest,hc:c.hc,ac:c.ac,
      league:c.league,group:g.id,kickoff:Timestamp.fromMillis(c.ms),week};
    if(!ex.has(c.id))Object.assign(base,{done:false,hs:null,as:null});
    await db.doc('fixtures/'+c.id).set(base,{merge:true});
  }
  console.log(g.id,week,'- ciyaaro la kaydiyay:',cand.length);
}
if(!okAny)throw new Error('Ma jiro horyaal la soo qaadi karay');

// Nadiifi ciyaaraha hore ee la doortay habka hore (aan lahayn 'group') ee aan weli dhicin
for(const d of (await db.collection('fixtures').where('done','==',false).get()).docs){
  const x=d.data();
  if(!x.group&&x.kickoff.toMillis()>Date.now()){await d.ref.delete();console.log('la tirtiray ciyaar hore:',d.id)}
}

// Natiijooyinka
const open=(await db.collection('fixtures').where('done','==',false).get()).docs;
let fin=0;
for(const d of open){
  const f=known.get(d.id);
  if(f&&f.done&&Number.isFinite(f.hs)&&Number.isFinite(f.as)){await d.ref.update({done:true,hs:f.hs,as:f.as});fin++}
}
console.log('natiijooyin la dhammeeyay:',fin);

// Liiska VIP (magacyo + sawirro) si Fans looga saaro VIP-ga
const names=[],photos={};
(await db.collection('vip').get()).docs.forEach(d=>{const x=d.data();if(x.name){names.push(x.name);if(x.photo)photos[x.name]=x.photo}});
await db.doc('meta/vip').set({names,photos,updated:Timestamp.now()});
console.log('VIP:',names.length);
