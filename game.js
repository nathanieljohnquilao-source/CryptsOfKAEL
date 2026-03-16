'use strict';
// ═══════════════════════════════════════════════════════════════════════════════
// CRYPTS OF KAEL  v3  ·  Pixel Turn-Based Roguelike
//
// Perf:  · Octant shadowcast FOV (replaces 180-ray scan)
//        · Enemy Set for O(1) collision checks
//        · Offscreen dungeon layer (pre-render seen tiles, blit per frame)
//        · Scanlines pre-rendered to offscreen canvas once
//        · setTimeout battle refs checked against current G.battle to prevent
//          stale closures from firing after new game
//
// New:   · 10 floor themes (colour palette shifts every 2 floors)
//        · Shop between floors (buy potions, upgrades, revive)
//        · Status effects: Poison, Stun, Burn, Regen
//        · Critical hits + Dodge chance
//        · 9 enemy types (4 new: Spider, Troll, Wraith, Dragon)
//        · 6 player skills (Quickstrike, Heal added)
//        · Passive HP regen outside battle
//        · Level-up stat choice (HP / ATK / DEF)
//        · Larger sprite art in battle (multi-row ASCII)
//        · Battle action descriptions shown in log
//        · Critical hit flash + CRIT! text
// ═══════════════════════════════════════════════════════════════════════════════

/* ── Constants ────────────────────────────────────────────────────────────── */
const TILE = 16;
const MAP_W = 64, MAP_H = 54;
const FOV_R = 7;

let VW=0, VH=0, OX=0, OY=0;

/* ── Tile / Visibility enums ─────────────────────────────────────────────── */
const T = { VOID:0, FLOOR:1, WALL:2, STAIRS:3, CHEST:4, SHOP:5 };
const V = { UNSEEN:0, SEEN:1, VISIBLE:2 };

/* ── Floor themes — colour palette changes every 2 floors ───────────────── */
const THEMES = [
  { name:'Stone Crypts', floor:'#1a1500', floor2:'#1e1900', wall:'#3d2e00', wallhi:'#5a4500', fg:'#ffcc66' },
  { name:'Forgotten Halls', floor:'#111a11', floor2:'#141e14', wall:'#224422', wallhi:'#336633', fg:'#88ff88' },
  { name:'Bloodstone Caves', floor:'#1a0c0c', floor2:'#1f1010', wall:'#441010', wallhi:'#662020', fg:'#ff8888' },
  { name:'Frozen Depths', floor:'#0c0c1a', floor2:'#10101f', wall:'#101044', wallhi:'#2020aa', fg:'#88aaff' },
  { name:'Infernal Pits', floor:'#1a0a00', floor2:'#1f0c00', wall:'#4a1a00', wallhi:'#882200', fg:'#ff6622' },
];
function getTheme(floor) { return THEMES[Math.min(Math.floor((floor-1)/2), THEMES.length-1)]; }

/* ── Palette ─────────────────────────────────────────────────────────────── */
const COL = {
  void:'#0a0800', seen:'rgba(0,0,0,.58)',
  stairs:'#ffe066', chest:'#ffcc00', shop:'#44ffaa',
  player:'#ffee88',
  // enemies — defined before EDEFS
  rat:'#cc8833', spider:'#aa4488', goblin:'#66bb44',
  skeleton:'#ccccaa', troll:'#558833', wraith:'#8888ff',
  demon:'#ff4422', dragon:'#ff8800', lich:'#ff2277',
  // items
  potion:'#ff4466', gold:'#ffcc00', wpn:'#88ccff',
  // battle
  bBg:'#0d0a00', bPanel:'#1a1400', bBord:'#5a3a00',
  bText:'#ffcc66', bDim:'#886633',
  bHit:'#ff6622', bHeal:'#44ff88', bMagic:'#cc88ff',
  bGood:'#44ff88', bBad:'#ff4422', bCrit:'#ffee00',
  bPoison:'#88ff44', bBurn:'#ff8822', bStun:'#ffff44',
};

/* ── Weapons ─────────────────────────────────────────────────────────────── */
const WEAPONS = [
  { name:'Fists',   atk:0,  sym:'@',  col:'#ffee88', crit:.05 },
  { name:'Dagger',  atk:3,  sym:'/',  col:'#aaddff', crit:.12 },
  { name:'Sword',   atk:6,  sym:'†',  col:'#88eeff', crit:.10 },
  { name:'Axe',     atk:10, sym:'‡',  col:'#ffaa44', crit:.08 },
  { name:'Staff',   atk:14, sym:'|',  col:'#cc88ff', crit:.14 },
  { name:'Scythe',  atk:18, sym:'ψ',  col:'#ff4466', crit:.18 },
];

/* ── Player skills ───────────────────────────────────────────────────────── */
const SKILLS = [
  { id:'attack',  name:'ATTACK',       key:'1', desc:'Strike for full damage.',    },
  { id:'quick',   name:'QUICKSTRIKE',  key:'2', desc:'2 hits, 60% dmg each.',      },
  { id:'heavy',   name:'HEAVY BLOW',   key:'3', desc:'1 hit, 180% dmg. Enemy goes next.', },
  { id:'defend',  name:'DEFEND',       key:'4', desc:'Halve damage taken this round.', },
  { id:'heal',    name:'HEAL',         key:'5', desc:'Restore 25% of max HP.',     },
  { id:'flee',    name:'FLEE',         key:'6', desc:'50%+lvl% chance to escape.', },
];

/* ── Enemy catalogue ─────────────────────────────────────────────────────── */
// actions: 'atk'=normal, 'pow'=power(1.6×), 'spc'=special, 'psn'=poison, 'stun'=stun, 'burn'=burn
const EDEFS = [
  { name:'Rat',     hp:6,   atk:2,  def:0, xp:3,  gold:0,  col:COL.rat,     sym:'r',
    minFloor:1, actions:['atk','atk','atk'],
    sprite:['  /\\  ','o(rr)o','  \\/  '] },
  { name:'Spider',  hp:9,   atk:3,  def:0, xp:5,  gold:0,  col:COL.spider,  sym:'s',
    minFloor:1, actions:['atk','psn','atk'],
    sprite:['/|\\|/|\\','( sss )','\\|/|\\|/'] },
  { name:'Goblin',  hp:14,  atk:4,  def:1, xp:8,  gold:2,  col:COL.goblin,  sym:'g',
    minFloor:1, actions:['atk','atk','pow'],
    sprite:['  /\\  ','<(gG)>','  /\\  '] },
  { name:'Skeleton',hp:20,  atk:6,  def:2, xp:13, gold:3,  col:COL.skeleton,sym:'S',
    minFloor:2, actions:['atk','pow','atk'],
    sprite:['  ()  ','/ SS \\','  ||  '] },
  { name:'Troll',   hp:36,  atk:7,  def:3, xp:20, gold:4,  col:COL.troll,   sym:'T',
    minFloor:2, actions:['atk','pow','atk'],
    sprite:['  /\\  ','[TROLL]','  ||  '] },
  { name:'Wraith',  hp:25,  atk:9,  def:1, xp:22, gold:5,  col:COL.wraith,  sym:'W',
    minFloor:3, actions:['atk','spc','stun'],
    sprite:[' ~~~~ ','( WW )','  ~~  '] },
  { name:'Demon',   hp:40,  atk:11, def:4, xp:30, gold:6,  col:COL.demon,   sym:'D',
    minFloor:3, actions:['pow','atk','burn'],
    sprite:[' /\\  /\\',' (DD)  ','  ||   '] },
  { name:'Dragon',  hp:70,  atk:14, def:5, xp:50, gold:12, col:COL.dragon,  sym:'Ω',
    minFloor:4, actions:['pow','burn','pow'],
    sprite:['<Ω===Ω>',' [   ] ','  ___  '] },
  { name:'Lich',    hp:90,  atk:16, def:6, xp:80, gold:20, col:COL.lich,    sym:'L',
    minFloor:5, actions:['atk','spc','psn'],
    sprite:['  )(  ',' [LL] ','  )(  '], isBoss:true },
];

/* ── Status effects ──────────────────────────────────────────────────────── */
// Applied to player or enemy: { type, duration, power }
// Resolved at start of affected entity's turn

/* ══════════════════════════════════════════════════════════════════════════════
   LORE — Kael is a mediocre wizard who turned his basement into a dungeon
   for passive income. You're looking for a bathroom. Monsters think
   you're a tax inspector. Nobody is having a good time.
══════════════════════════════════════════════════════════════════════════════ */
const LORE = {
  intro:[
    '         IN THE YEAR OF OUR LORD',
    '      FOURTEEN-SOMETHING-OR-OTHER...',
    '',
    '  KAEL was a wizard of middling talent.',
    '  His spells mostly fizzled.',
    '  His tower application was rejected FOUR TIMES.',
    '',
    '  So instead, he dug a hole.',
    '',
    '  "I will rent it to monsters," he said.',
    '  "Passive income," he said.',
    '  "Totally fine," he said.',
    '',
    '  YOU wandered in looking for a bathroom.',
    '',
    '  The monsters think you are a tax inspector.',
    '  They are NOT happy about it.',
    '',
    '            [ TAP / ANY KEY ]',
  ],
  floors:[
    ['  FLOOR 1: THE BASEMENT','','  Smells like mildew and poor choices.','  A sign reads: NO PARTIES. NO FIRE.','  Below it, smaller: "No tax inspectors.','  I mean it, Gerald."','','  You are not Gerald. This does not help.','','  [ TAP / ANY KEY ]'],
    ['  FLOOR 2: THE FORGOTTEN HALLS','','  A notice board:','  "MONSTER UNION MEETING — TUES 7PM','   Agenda: Wages, Benefits, Adventurers","  Refreshments provided (BYOB)"','','  The rats are unionised. Wonderful.','','  [ TAP / ANY KEY ]'],
    ['  FLOOR 3: THE BLOODSTONE CAVES','','  A skeleton waves at you cheerfully.','  Then attacks. Then apologises mid-attack.','  "Sorry! Contractual obligation!"','','  You appreciate the honesty.','  Less so the sword.','','  [ TAP / ANY KEY ]'],
    ['  FLOOR 4: THE FROZEN DEPTHS','','  KAEL added an "Ice Wing" to attract','  Premium Tenant Wraiths.','  They left a 2-star review.','  ("Draughty. Would haunt again.")','','  A wraith drifts past reading yesterday\'s news.','  They\'re dead. Time is irrelevant.','','  [ TAP / ANY KEY ]'],
    ['  FLOOR 5: THE INFERNAL PITS','','  KAEL\'s premium tier. Demons pay extra','  for the mood lighting and lava views.','','  A certificate on the wall:','  "5-STAR FIEND APPROVED"','  "Best Structural Integrity: 3rd Year"','','  You are definitely going to die here.','','  [ TAP / ANY KEY ]'],
    ['  FLOOR 6: THE DROWNED VAULTS','','  A water feature. KAEL is proud of it.','  It was supposed to be a library.','  The books are destroyed.','  The spiders love it though.','','  It is, genuinely, kind of pretty.','  You are still going to die.','','  [ TAP / ANY KEY ]'],
    ['  FLOOR 7: THE OSSUARY','','  Where KAEL stores failed experiments.','  There are a LOT of experiments.','','  A jar labelled "STEVE" watches you pass.','  You don\'t look back.','  Steve watches.','','  [ TAP / ANY KEY ]'],
    ['  FLOOR 8: THE PHILOSOPHER\'S STAIRWELL','','  A Lich sits at a desk, writing.','  "Do NOT disturb me. PhD thesis.','   Chapter 14. Almost done."','','  You disturb it. It is very displeased.','  Academically AND violently.','','  [ TAP / ANY KEY ]'],
    ['  FLOOR 9: THE WAILING CHAMBERS','','  The walls whisper KAEL\'s regrets:','  "Should have taken the tower mortgage."','  "Should have replied to Gerald."','','  Somewhere above, KAEL watches on a crystal','  ball, eating crackers. He looks impressed.','','  [ TAP / ANY KEY ]'],
    ['  THE FINAL DEPTHS','','  You can hear breathing ahead.','  Not the monster kind.','  The wizard kind. Nervous. Snacky.','','  KAEL himself awaits.','  He has prepared a speech.','  He has also prepared an escape portal.','','  [ TAP / ANY KEY ]'],
  ],
  taunts:{
    'Rat':['Rat waves a tiny sign: "FAIR WAGES NOW"','Rat demands to see your adventurer\'s licence.','This Rat is the shop steward. Good luck.','Filed a grievance about fighting you. Still fights.'],
    'Spider':['The Spider has been waiting. It has PLANS.','Eight legs in greeting. Eight legs in violence.','It has been redecorating. You are the centrepiece.','Hisses: "Finally. A visitor for my web."'],
    'Goblin':['OI! You got a permit for that sword?!','You don\'t look like a tax inspector. Fight anyway.','KAEL said we\'d get overtime. We won\'t.','On its phone. Hangs up. "Gotta go. Work stuff."'],
    'Skeleton':['I am SO sorry about this. It attacks.','Contractual obligation. Nothing personal.','You seem nice. Most people seem nice. Sword raises.','Could you water my plant? Third alcove. Right.'],
    'Troll':['Eating a rock. Does not look up. Then does.','Is small. Will still hurt small.','Named its club "Coincidence." This seems wrong.','Troll tired of adventurers. Will nap after.'],
    'Wraith':['You interrupt my HAUNTING. I had ATMOSPHERE going.','Living. Ugh. Attacks with maximum disdain.','400 years dead. Never been this inconvenienced.','FINE. One haunting. Logging it as overtime.'],
    'Demon':['A mortal? Down HERE? You\'re brave or stupid.','Consults clipboard. Not on list. Attacks anyway.','KAEL charged me extra for lava views. Anger redirected.','Three stars on the dungeon review. THREE.'],
    'Dragon':['In a basement. "Don\'t ask," it says.','Was promised a MOUNTAIN. Got a basement with a Troll.','Ceilings are LOW, it growls. Then breathes fire.','Got a discount from Kael. Should have known.'],
    'Lich':['CHAPTER FOURTEEN WAS ALMOST DONE.','Five centuries of unlife. THIS is my morning.','I have a PhD. From a GOOD university. Attacks.','My supervisor will hear about this.'],
  },
  merchant:[
    '"KAEL\'s prices. Not mine. Don\'t look at me."',
    '"Everything\'s authentic dungeon-sourced. Mostly."',
    '"I\'m just here for the dental plan."',
    '"Rats unionised the supply chain. Prices went up."',
    '"Floor 5 has a lava pool. Very soothing. Don\'t fall in."',
    '"KAEL asked me to stop selling to adventurers. I said no."',
    '"Been here 12 years. I forget what sky looks like."',
    '"The Skeleton on floor 3 is genuinely lovely."',
    '"Why ARE you here? The bathroom thing seems unlikely."',
    '"You\'ve lasted longer than most. Not a compliment yet."',
  ],
  eulogies:[
    'Sought a bathroom.\nFound only monsters.\nFound no bathroom.',
    'The Rats fought harder.\n(They were on overtime. It helps.)',
    'Slain by a Skeleton\nthat was sorry the whole time.',
    'The sign said NO ADVENTURERS.\nHindsight is 20/20.',
    'Got further than Gerald.\nThis is the highest praise available.',
    'The Merchant lowers prices in your honour.\nJust kidding. Prices stay the same.',
    'The Wraith wrote a 1-star review:\n"Adventurer interrupted my haunting. 1/5."',
    'A hero in every way that matters.\nNone of which were useful down here.',
    'The Troll named its club after you.\nThis is either honour or threat.',
    'The Lich finished Chapter 14.\nYou contributed nothing. Nor subtracted.\nYou simply ceased.',
    'KAEL watched from his crystal ball.\nAte crackers. Felt bad. Ate more crackers.',
    'Died as they lived: confused\nabout why there were so many monsters here.',
  ],
  victory:[
    '  KAEL finishes his speech.',
    '  You are, somehow, still standing.',
    '',
    '  KAEL stares.',
    '  You stare back.',
    '',
    '  "...right," he says.',
    '',
    '  He opens his escape portal.',
    '  Steps through. Closes it behind him.',
    '',
    '  The dungeon is quiet.',
    '  There is still no bathroom.',
    '',
    '          ★  YOU WIN  ★',
    '',
    '  (Kael got a studio flat in the capital.',
    '   Two stars on Zillow. He is fine.)',
    '',
    '         [ TAP / ANY KEY ]',
  ],
};

/* ══════════════════════════════════════════════════════════════════════════════
   DIALOGUE ENGINE — typewriter overlay drawn on the game canvas
══════════════════════════════════════════════════════════════════════════════ */
const DLG = (() => {
  let _active=false, _lines=[], _li=0, _ci=0, _speed=32, _acc=0, _done=false, _cb=null;
  const taunted=new Set();

  function show(lines, cb, fast=false){
    _lines=lines; _li=0; _ci=0; _speed=fast?90:32; _acc=0; _done=false; _active=true; _cb=cb||null;
  }
  function dismiss(){
    if(!_active)return;
    if(!_done){ _li=_lines.length-1; _ci=(_lines[_li]||'').length; _done=true; return; }
    _active=false;
    const cb=_cb; _cb=null;
    if(cb) cb();
  }
  function tick(dt){
    if(!_active||_done)return;
    _acc+=dt*_speed;
    let steps=Math.floor(_acc); _acc-=steps;
    while(steps-->0){
      if(_li>=_lines.length){_done=true;return;}
      _ci++;
      if(_ci>(_lines[_li]||'').length){_li++;_ci=0;if(_li>=_lines.length){_done=true;return;}}
    }
  }
  function draw(ctx,W,H){
    if(!_active)return;
    ctx.fillStyle='rgba(0,0,0,.87)'; ctx.fillRect(0,0,W,H);
    const pw=Math.min(W-24,460), ph=Math.min(H-60,400);
    const px=(W-pw)/2, py=(H-ph)/2;
    ctx.fillStyle='#0c0800'; _rr(ctx,px,py,pw,ph,5); ctx.fill();
    ctx.strokeStyle='#7a5000'; ctx.lineWidth=2; _rr(ctx,px,py,pw,ph,5); ctx.stroke();
    ctx.strokeStyle='rgba(255,179,0,.07)'; ctx.lineWidth=1; _rr(ctx,px+4,py+4,pw-8,ph-8,3); ctx.stroke();

    const lh=Math.min(21,Math.floor((ph-40)/Math.max(_lines.length,10)));
    const fs=Math.max(12,Math.round(lh*0.86));
    ctx.font=`${fs}px VT323,monospace`;
    ctx.textBaseline='top'; ctx.textAlign='left';
    const tx=px+18, ty0=py+14;

    for(let i=0;i<_lines.length;i++){
      const raw=_lines[i]||'';
      const shown = i<_li?raw : i===_li?raw.slice(0,_ci) : '';
      if(i>_li&&!shown)break;
      if(!raw.trim())continue;
      const isBlink=raw.includes('TAP')||raw.includes('ANY KEY');
      const isHdr=i===0||raw.includes('★')||raw.startsWith('  FLOOR')||raw.startsWith('  THE FINAL');
      if(isBlink){
        ctx.fillStyle=_done?(Math.floor(Date.now()/400)%2?'#ffee44':'#aa8800'):'#554400';
      } else if(isHdr){ ctx.fillStyle='#ffe066';
      } else if(i<3){ ctx.fillStyle='#ffcc66';
      } else { ctx.fillStyle='#bb8833'; }
      ctx.fillText(shown,tx,ty0+i*lh);
    }
    // cursor
    if(!_done&&_li<_lines.length){
      if(Math.floor(Date.now()/280)%2){
        const cx2=tx+ctx.measureText((_lines[_li]||'').slice(0,_ci)).width+1;
        ctx.fillStyle='#ffcc66'; ctx.fillRect(cx2,ty0+_li*lh+2,5,fs-2);
      }
    }
    ctx.globalAlpha=1;
  }
  function _rr(c,x,y,w,h,r){
    c.beginPath();c.moveTo(x+r,y);c.lineTo(x+w-r,y);c.arcTo(x+w,y,x+w,y+r,r);
    c.lineTo(x+w,y+h-r);c.arcTo(x+w,y+h,x+w-r,y+h,r);
    c.lineTo(x+r,y+h);c.arcTo(x,y+h,x,y+h-r,r);c.lineTo(x,y+r);c.arcTo(x,y,x+r,y,r);
    c.closePath();
  }
  return { show, dismiss, tick, draw, isActive:()=>_active, taunted };
})();

/* ── DOM ─────────────────────────────────────────────────────────────────── */
const $      = id => document.getElementById(id);
const canvas = $('gameCanvas');
const ctx    = canvas.getContext('2d');
const msglog = $('msglog');

/* ── Offscreen canvases ──────────────────────────────────────────────────── */
let dungeonLayer = null;   // pre-rendered seen tiles
let dungeonDirty = true;   // re-render next draw
let scanlineLayer= null;   // pre-rendered scanlines for battle

/* ── Game state ───────────────────────────────────────────────────────────── */
let G = null;
let battleId = 0;  // increments on each battle entry; used to cancel stale setTimeouts

function freshPlayer() {
  return {
    x:0, y:0,
    hp:24, maxHp:24,
    atk:4, def:1,
    gold:0, xp:0, level:1, xpNext:15,
    weaponIdx:0, dodge:.05,
    floor:1, kills:0, totalDmgDealt:0,
    status:[],          // [{type,dur,power}]
    defending:false,
    pendingLevelUp:false,
    regenTick:0,        // countdown turns until 1 HP regen outside battle
  };
}

function freshState() {
  return {
    map:null, vis:null, rooms:[],
    enemies:[], enemySet:new Set(),
    items:[],
    player:freshPlayer(),
    particles:[],
    turn:0,
    phase:'player',
    mapW:MAP_W, mapH:MAP_H,
    stairsX:0, stairsY:0,
    battle:null,
    shopOpen:false,
  };
}

function freshBattle(enemy) {
  return {
    id: ++battleId,
    enemy,
    phase:'choose',
    log:[],
    selectedSkill:0,
    playerShake:0, enemyShake:0,
    playerFlash:0, enemyFlash:0,
    playerFlashCol:'#ff4422', enemyFlashCol:'#ff6622',
    playerBob:0, enemyBob:0,
    resultText:'', resultTimer:0,
    skipNextTurn:false,
    healUsed:0,   // times heal used this battle (gets more expensive)
  };
}

/* ── Screens ─────────────────────────────────────────────────────────────── */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  $(id).classList.add('active');
}

/* ── Persistence ─────────────────────────────────────────────────────────── */
const LS = {
  get:(k,d=0)=>parseInt(localStorage.getItem(k)||String(d)),
  set:(k,v)=>localStorage.setItem(k,v),
};
const getBestFloor = ()=>LS.get('kael_floor');
const getBestScore = ()=>LS.get('kael_score');
const getBestKills = ()=>LS.get('kael_kills');
function saveBest(p) {
  if(p.floor>getBestFloor()) LS.set('kael_floor',p.floor);
  const score=p.floor*100+p.kills*10+p.gold;
  if(score>getBestScore()) LS.set('kael_score',score);
  if(p.kills>getBestKills()) LS.set('kael_kills',p.kills);
}
function updateTitleBest(){
  const f=getBestFloor(),s=getBestScore(),k=getBestKills();
  $('best-score').textContent= f>0?`BEST  FLOOR:${f}  SCORE:${s}  KILLS:${k}`:'';
}
updateTitleBest();

/* ── Buttons ─────────────────────────────────────────────────────────────── */
$('btn-start').onclick     = startGame;
$('btn-retry').onclick     = startGame;
$('btn-dead-menu').onclick = ()=>{ showScreen('screen-title'); updateTitleBest(); };

/* ── Resize ──────────────────────────────────────────────────────────────── */
const SB_H=()=>44;
const ML_H=()=>G?.phase==='battle'?0:68;
const DP_H=()=>G?.phase==='battle'?0:G?.shopOpen?0:isMobile()?152:0;
const SHOP_H=()=>G?.shopOpen&&G?.phase!=='battle'?140:0;

function isMobile(){ return window.innerWidth<=760||'ontouchstart' in window; }

function resizeCanvas(){
  const W=window.innerWidth;
  const H=window.innerHeight-SB_H()-ML_H()-DP_H()-SHOP_H();
  canvas.style.top=SB_H()+'px';
  canvas.style.left='0px';
  canvas.width=W;
  canvas.height=Math.max(H,160);
  VW=Math.ceil(canvas.width/TILE)+2;
  VH=Math.ceil(canvas.height/TILE)+2;
  const inBattle=G?.phase==='battle';
  const inShop=G?.shopOpen&&!inBattle;
  $('dpad').style.display=(!inBattle&&!inShop&&isMobile())?'flex':'none';
  $('msglog').style.display=inBattle?'none':'flex';
  $('msglog').style.bottom=(DP_H()+SHOP_H())+'px';
  $('battle-ui').style.display=inBattle?'flex':'none';
  $('shop-ui').style.display=inShop?'flex':'none';
  // Rebuild offscreen scanlines on resize
  buildScanlineLayer();
  dungeonDirty=true;
  if(G&&G.phase!=='battle') centerCamera();
}
window.addEventListener('resize',resizeCanvas);

/* ── Offscreen scanlines ─────────────────────────────────────────────────── */
function buildScanlineLayer(){
  if(!canvas.width||!canvas.height) return;
  scanlineLayer=document.createElement('canvas');
  scanlineLayer.width=canvas.width; scanlineLayer.height=canvas.height;
  const g=scanlineLayer.getContext('2d');
  g.fillStyle='rgba(0,0,0,.15)';
  for(let y=0;y<canvas.height;y+=3) g.fillRect(0,y,canvas.width,1);
}

/* ── Dungeon offscreen layer ─────────────────────────────────────────────── */
function buildDungeonLayer(){
  if(!G) return;
  const W=canvas.width, H=canvas.height;
  if(!dungeonLayer||dungeonLayer.width!==W||dungeonLayer.height!==H){
    dungeonLayer=document.createElement('canvas');
    dungeonLayer.width=W; dungeonLayer.height=H;
  }
  const g=dungeonLayer.getContext('2d');
  const th=getTheme(G.player.floor);
  const camX=OX,camY=OY;
  g.fillStyle=COL.void;g.fillRect(0,0,W,H);
  for(let ty=camY;ty<camY+VH+1;ty++){
    for(let tx=camX;tx<camX+VW+1;tx++){
      if(tx<0||ty<0||tx>=MAP_W||ty>=MAP_H)continue;
      const vis=G.vis[ty][tx]; if(vis===V.UNSEEN)continue;
      const t=G.map[ty][tx];
      const px=(tx-camX)*TILE, py=(ty-camY)*TILE;
      if(t===T.FLOOR){
        g.fillStyle=((tx+ty)%2===0)?th.floor:th.floor2;g.fillRect(px,py,TILE,TILE);
        g.fillStyle='rgba(0,0,0,.22)';g.fillRect(px,py,1,TILE);g.fillRect(px,py,TILE,1);
      } else if(t===T.WALL){
        g.fillStyle=th.wall;g.fillRect(px,py,TILE,TILE);
        g.fillStyle=th.wallhi;g.fillRect(px,py,TILE,3);g.fillRect(px,py,2,TILE);
        g.fillStyle='rgba(0,0,0,.45)';g.fillRect(px,py+TILE-2,TILE,2);g.fillRect(px+TILE-2,py,2,TILE);
      } else if(t===T.STAIRS){
        g.fillStyle=th.floor;g.fillRect(px,py,TILE,TILE);
        g.fillStyle=COL.stairs;g.font='12px VT323,monospace';
        g.textAlign='center';g.textBaseline='middle';
        g.fillText('<',px+TILE/2,py+TILE/2+1);
      } else if(t===T.CHEST){
        g.fillStyle=th.floor;g.fillRect(px,py,TILE,TILE);
        g.fillStyle='#7a4a00';g.fillRect(px+2,py+5,TILE-4,TILE-7);
        g.fillStyle='#ffcc00';g.fillRect(px+TILE/2-1,py+TILE/2,2,2);
      } else if(t===T.SHOP){
        g.fillStyle=th.floor;g.fillRect(px,py,TILE,TILE);
        g.fillStyle=COL.shop;g.font='11px VT323,monospace';
        g.textAlign='center';g.textBaseline='middle';
        g.fillText('$',px+TILE/2,py+TILE/2+1);
      } else {
        g.fillStyle=COL.void;g.fillRect(px,py,TILE,TILE);
      }
      if(vis===V.SEEN){g.fillStyle=COL.seen;g.fillRect(px,py,TILE,TILE);}
    }
  }
  dungeonDirty=false;
}

/* ══════════════════════════════════════════════════════════════════════════════
   DUNGEON GENERATION
══════════════════════════════════════════════════════════════════════════════ */
function generateDungeon(floor){
  const map=Array.from({length:MAP_H},()=>new Array(MAP_W).fill(T.WALL));
  const vis=Array.from({length:MAP_H},()=>new Array(MAP_W).fill(V.UNSEEN));
  const rooms=[];
  const MIN=5,MAX=15;

  function split(x,y,w,h,depth){
    if(depth===0||(w<MIN*2+3&&h<MIN*2+3)){
      const rw=MIN+Math.floor(Math.random()*(Math.min(w-4,MAX)-MIN+1));
      const rh=MIN+Math.floor(Math.random()*(Math.min(h-4,MAX)-MIN+1));
      const rx=x+1+Math.floor(Math.random()*(Math.max(1,w-rw-2)));
      const ry=y+1+Math.floor(Math.random()*(Math.max(1,h-rh-2)));
      rooms.push({x:rx,y:ry,w:rw,h:rh});
      for(let cy=ry;cy<ry+rh;cy++) for(let cx=rx;cx<rx+rw;cx++) map[cy][cx]=T.FLOOR;
      return {cx:Math.floor(rx+rw/2),cy:Math.floor(ry+rh/2)};
    }
    const horiz=w>h?(Math.random()<.65):(Math.random()<.35);
    let c1,c2;
    if(horiz){
      const sx=x+MIN+Math.floor(Math.random()*(w-MIN*2));
      c1=split(x,y,sx-x,h,depth-1);c2=split(sx,y,w-(sx-x),h,depth-1);
    } else {
      const sy=y+MIN+Math.floor(Math.random()*(h-MIN*2));
      c1=split(x,y,w,sy-y,depth-1);c2=split(x,sy,w,h-(sy-y),depth-1);
    }
    carveCorr(map,c1.cx,c1.cy,c2.cx,c2.cy);
    return {cx:Math.floor((c1.cx+c2.cx)/2),cy:Math.floor((c1.cy+c2.cy)/2)};
  }
  split(0,0,MAP_W,MAP_H,4);

  // Stairs in last room
  const lr=rooms[rooms.length-1];
  const stX=Math.floor(lr.x+lr.w/2), stY=Math.floor(lr.y+lr.h/2);
  map[stY][stX]=T.STAIRS;

  // Chests
  const nc=1+Math.floor(Math.random()*2)+(floor>2?1:0);
  shuffle(rooms.slice(1)).slice(0,nc).forEach(r=>{
    const cx=r.x+1+Math.floor(Math.random()*(r.w-2));
    const cy=r.y+1+Math.floor(Math.random()*(r.h-2));
    if(map[cy][cx]===T.FLOOR) map[cy][cx]=T.CHEST;
  });

  // Shop (always one, in a random middle room)
  if(rooms.length>3){
    const sr=rooms[1+Math.floor(Math.random()*(rooms.length-2))];
    const sx2=sr.x+1+Math.floor(Math.random()*(sr.w-2));
    const sy2=sr.y+1+Math.floor(Math.random()*(sr.h-2));
    if(map[sy2][sx2]===T.FLOOR) map[sy2][sx2]=T.SHOP;
  }

  return {map,vis,rooms,stX,stY};
}

function carveCorr(map,x1,y1,x2,y2){
  let cx=x1,cy=y1;
  // Add 1-tile width to corridors (makes them navigable)
  const carve=(cx,cy)=>{
    if(cx>=0&&cy>=0&&cx<MAP_W&&cy<MAP_H){ map[cy][cx]=T.FLOOR; }
    // Also carve perpendicular tile for width
    const nx=cx+(y1!==y2?1:0), ny=cy+(x1!==x2?1:0);
    if(nx>=0&&ny>=0&&nx<MAP_W&&ny<MAP_H) map[ny][nx]=T.FLOOR;
  };
  while(cx!==x2){carve(cx,cy);cx+=cx<x2?1:-1;}
  while(cy!==y2){carve(cx,cy);cy+=cy<y2?1:-1;}
}

function shuffle(arr){
  for(let i=arr.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];}
  return arr;
}

function spawnEnemies(rooms,map,floor){
  const enemies=[], set=new Set();
  const pool=EDEFS.filter(e=>e.minFloor<=floor&&!e.isBoss);
  const bossPool=EDEFS.filter(e=>e.minFloor<=floor&&e.isBoss);

  for(let ri=1;ri<rooms.length;ri++){
    const r=rooms[ri];
    const isBossRoom=(ri===rooms.length-1);
    let count=isBossRoom?1:Math.max(1,1+Math.floor(Math.random()*(1+Math.floor(floor/2))));

    for(let i=0;i<count;i++){
      let def;
      if(isBossRoom&&i===0&&floor>=5&&bossPool.length)
        def=bossPool[Math.floor(Math.random()*bossPool.length)];
      else def=pool[Math.floor(Math.random()*pool.length)];

      let ex,ey,tries=0;
      do{
        ex=r.x+1+Math.floor(Math.random()*(r.w-2));
        ey=r.y+1+Math.floor(Math.random()*(r.h-2));
        tries++;
      }while((map[ey][ex]!==T.FLOOR||set.has(ey*MAP_W+ex))&&tries<40);
      if(tries>=40) continue;

      const hpScale=1+floor*.18, atkScale=1+floor*.1;
      const e={
        ...def,
        hp: Math.round(def.hp*hpScale), maxHp:Math.round(def.hp*hpScale),
        atk:Math.round(def.atk*atkScale),
        x:ex,y:ey, id:Math.random(),
        guardX:ex,guardY:ey,
        status:[],
        turnsSinceLastMove:0,
      };
      enemies.push(e); set.add(ey*MAP_W+ex);
    }
  }
  return enemies;
}

function spawnItems(rooms,map,floor){
  const items=[];
  rooms.forEach((r,ri)=>{
    if(ri>0&&Math.random()>.5) return;
    let ix,iy,tries=0;
    do{ix=r.x+1+Math.floor(Math.random()*(r.w-2));iy=r.y+1+Math.floor(Math.random()*(r.h-2));tries++;}
    while(map[iy][ix]!==T.FLOOR&&tries<20);
    if(tries>=20) return;
    const roll=Math.random();
    if(roll<.45) items.push({type:'gold',x:ix,y:iy,val:2+Math.floor(Math.random()*6)+floor});
    else if(roll<.68) items.push({type:'potion',x:ix,y:iy,val:8+Math.floor(Math.random()*10)+floor});
    else if(roll<.85){
      const wi=Math.min(Math.floor(floor/2)+1+Math.floor(Math.random()*2),WEAPONS.length-1);
      items.push({type:'weapon',x:ix,y:iy,weaponIdx:wi});
    } else {
      items.push({type:'elixir',x:ix,y:iy}); // permanent +2 maxHP
    }
  });
  return items;
}

/* ══════════════════════════════════════════════════════════════════════════════
   FOV — Octant shadowcasting (much faster than 180-ray scan)
══════════════════════════════════════════════════════════════════════════════ */
function computeFOV(){
  const p=G.player;
  // Reset visible → seen
  for(let y=0;y<MAP_H;y++) for(let x=0;x<MAP_W;x++)
    if(G.vis[y][x]===V.VISIBLE) G.vis[y][x]=V.SEEN;

  // Mark origin
  G.vis[p.y][p.x]=V.VISIBLE;

  // Cast 8 octants
  for(let oct=0;oct<8;oct++) castOctant(oct,p.x,p.y,1,1,0);

  dungeonDirty=true;
}

function castOctant(octant,ox,oy,row,startSlope,endSlope){
  // Transform vectors per octant
  const transforms=[
    [1,0,0,1],[0,1,1,0],[-1,0,0,1],[0,-1,1,0],
    [1,0,0,-1],[0,1,-1,0],[-1,0,0,-1],[0,-1,-1,0],
  ];
  const [xx,xy,yx,yy]=transforms[octant];

  if(startSlope<endSlope) return;
  let newStart=startSlope;
  let blocked=false;

  for(let dist=row;dist<=FOV_R&&!blocked;dist++){
    for(let dx=-dist;dx<=0;dx++){
      const dy=-dist;
      // Apply transform
      const mx=ox+dx*xx+dy*xy;
      const my=oy+dx*yx+dy*yy;
      if(mx<0||my<0||mx>=MAP_W||my>=MAP_H) continue;

      const lSlope=(dx-0.5)/(dy+0.5);
      const rSlope=(dx+0.5)/(dy-0.5);
      if(startSlope<rSlope) continue;
      if(endSlope>lSlope) break;

      if(Math.hypot(dx,dy)<=FOV_R) G.vis[my][mx]=V.VISIBLE;
      const wall=G.map[my][mx]===T.WALL||G.map[my][mx]===T.VOID;
      if(blocked){
        if(wall) newStart=rSlope;
        else { blocked=false; startSlope=newStart; }
      } else if(wall&&dist<FOV_R){
        blocked=true;
        castOctant(octant,ox,oy,dist+1,startSlope,lSlope);
        newStart=rSlope;
      }
    }
    if(blocked) break;
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   GAME START / FLOOR
══════════════════════════════════════════════════════════════════════════════ */
let animId=null;
function startGame(){
  if(animId){cancelAnimationFrame(animId);animId=null;}
  DLG.taunted.clear();
  dungeonLayer=null; dungeonDirty=true;
  G=freshState();
  loadFloor(1);
  showScreen('screen-game');
  resizeCanvas();
  updateHUD();
  animId=requestAnimationFrame(loop);
  // Show intro after first frame renders
  requestAnimationFrame(()=>DLG.show(LORE.intro,null,false));
}

function loadFloor(floorNum){
  const p=G.player;
  p.floor=floorNum;
  const {map,vis,rooms,stX,stY}=generateDungeon(floorNum);
  G.map=map; G.vis=vis; G.rooms=rooms;
  G.stairsX=stX; G.stairsY=stY;
  G.enemies=spawnEnemies(rooms,map,floorNum);
  G.enemySet=new Set(G.enemies.map(e=>e.y*MAP_W+e.x));
  G.items=spawnItems(rooms,map,floorNum);
  G.particles=[]; G.phase='player'; G.battle=null; G.shopOpen=false;
  const r0=rooms[0];
  p.x=Math.floor(r0.x+r0.w/2); p.y=Math.floor(r0.y+r0.h/2);
  // Partial heal on floor transition
  p.hp=Math.min(p.maxHp, p.hp+Math.ceil(p.maxHp*.2));
  computeFOV(); centerCamera();
  dungeonDirty=true;
  updateHUD();
  const th=getTheme(floorNum);
  msg(`Floor ${floorNum}: ${th.name}`, th.fg);
  // Floor lore (skip floor 1 — covered by intro crawl)
  if(floorNum>1){
    const idx=Math.min(floorNum-1,LORE.floors.length-1);
    DLG.show(LORE.floors[idx],null,true);
  }
}

function centerCamera(){
  OX=Math.max(0,Math.min(G.player.x-Math.floor(VW/2),MAP_W-VW));
  OY=Math.max(0,Math.min(G.player.y-Math.floor(VH/2),MAP_H-VH));
}

/* ══════════════════════════════════════════════════════════════════════════════
   HUD
══════════════════════════════════════════════════════════════════════════════ */
function updateHUD(){
  const p=G.player;
  $('stat-hp').textContent   =Math.max(0,p.hp);
  $('stat-maxhp').textContent=p.maxHp;
  $('stat-floor').textContent=p.floor;
  $('stat-atk').textContent  =p.atk+WEAPONS[p.weaponIdx].atk;
  $('stat-def').textContent  =p.def;
  $('stat-gold').textContent =p.gold;
  const pct=Math.max(0,p.hp/p.maxHp*100);
  $('hp-bar').style.width=pct+'%';
  $('hp-bar').style.background=pct>50?'#44ff66':pct>25?'#ffcc00':'#ff3322';
  // XP bar
  const xpEl=$('xp-bar');
  if(xpEl) xpEl.style.width=Math.min(100,p.xp/p.xpNext*100)+'%';
  // Status icons
  const stEl=$('stat-status');
  if(stEl) stEl.textContent=p.status.map(s=>
    s.type==='poison'?'☠':s.type==='burn'?'🔥':s.type==='stun'?'★':s.type==='regen'?'♥':''
  ).join('');
}

const MSG_MAX=5;
function msg(text,color='#cc9933'){
  const d=document.createElement('div');
  d.className='msg-line';d.textContent=text;d.style.color=color;
  msglog.insertBefore(d,msglog.firstChild);
  while(msglog.children.length>MSG_MAX) msglog.removeChild(msglog.lastChild);
}

/* ══════════════════════════════════════════════════════════════════════════════
   INPUT — DUNGEON
══════════════════════════════════════════════════════════════════════════════ */
const DIR={n:[0,-1],s:[0,1],e:[1,0],w:[-1,0],nw:[-1,-1],ne:[1,-1],sw:[-1,1],se:[1,1]};

document.addEventListener('keydown',e=>{
  if(DLG.isActive()){DLG.dismiss();e.preventDefault();e.stopPropagation();return;}
  if(G?.phase==='battle'){handleBattleKey(e.key);e.preventDefault();return;}
  if(G?.shopOpen){handleShopKey(e.key);e.preventDefault();return;}
  if(G?.player?.pendingLevelUp){handleLevelUpKey(e.key);e.preventDefault();return;}
  if(G?.phase!=='player') return;
  const kmap={ArrowUp:'n',ArrowDown:'s',ArrowLeft:'w',ArrowRight:'e',
    w:'n',a:'w',s:'s',d:'e',q:'nw',e:'ne',z:'sw',c:'se','.':'wait',' ':'wait'};
  const dir=kmap[e.key];
  if(dir){e.preventDefault();playerAction(dir);}
});

document.querySelectorAll('.dpad-btn').forEach(btn=>{
  const act=()=>{ if(G?.phase==='player') playerAction(btn.dataset.dir); };
  btn.addEventListener('touchstart',e=>{e.preventDefault();act();},{passive:false});
  btn.addEventListener('click',act);
});

let swX=0,swY=0;
canvas.addEventListener('touchstart',e=>{
  if(DLG.isActive()){e.preventDefault();DLG.dismiss();return;}
  swX=e.touches[0].clientX;swY=e.touches[0].clientY;
},{passive:false});
canvas.addEventListener('touchend',e=>{
  if(DLG.isActive())return; // dismiss handled in touchstart
  if(G?.phase!=='player') return;
  const t=e.changedTouches[0];
  const dx=t.clientX-swX,dy=t.clientY-swY;
  if(Math.abs(dx)<12&&Math.abs(dy)<12) return;
  if(Math.abs(dx)>Math.abs(dy)) playerAction(dx>0?'e':'w');
  else playerAction(dy>0?'s':'n');
},{passive:true});

/* ══════════════════════════════════════════════════════════════════════════════
   PLAYER MOVEMENT
══════════════════════════════════════════════════════════════════════════════ */
function playerAction(dir){
  if(dir==='wait'){endPlayerTurn();return;}
  const p=G.player;
  const [dx,dy]=DIR[dir];
  const nx=p.x+dx,ny=p.y+dy;
  if(nx<0||ny<0||nx>=MAP_W||ny>=MAP_H)return;
  const tile=G.map[ny][nx];
  const key=ny*MAP_W+nx;

  // Enemy — enter battle
  if(G.enemySet.has(key)){
    const e=G.enemies.find(en=>en.x===nx&&en.y===ny);
    if(e){enterBattle(e);return;}
  }

  if(tile===T.WALL||tile===T.VOID) return;

  // Move
  G.enemySet.delete(p.y*MAP_W+p.x); // not used for player but keeps parity
  p.x=nx;p.y=ny;

  // Auto-pickup
  const ii=G.items.findIndex(i=>i.x===nx&&i.y===ny);
  if(ii>=0){pickupItem(G.items[ii]);G.items.splice(ii,1);}

  if(tile===T.CHEST){G.map[ny][nx]=T.FLOOR;openChest(nx,ny);dungeonDirty=true;}
  if(tile===T.SHOP){openShop();return;}
  if(tile===T.STAIRS){nextFloor();return;}

  computeFOV();centerCamera();endPlayerTurn();
}

function endPlayerTurn(){
  // Passive regen outside battle
  const p=G.player;
  p.regenTick++;
  if(p.regenTick>=8&&p.hp<p.maxHp){p.hp=Math.min(p.maxHp,p.hp+1);p.regenTick=0;}

  // Tick player status
  tickStatus(p,'player');

  G.phase='enemy';
  runEnemyTurns();
  G.turn++;
  G.phase='player';
  updateHUD();

  // Level-up pending?
  if(p.pendingLevelUp) showLevelUpChoice();
  if(p.hp<=0) playerDies();
}

/* ── Enemy map AI ─────────────────────────────────────────────────────────── */
function runEnemyTurns(){
  const p=G.player;
  for(const e of G.enemies){
    if(G.vis[e.y][e.x]!==V.VISIBLE) continue;
    tickStatus(e,'enemy');
    if(hasStatus(e,'stun')) continue; // stunned — skip turn

    const dist=Math.abs(e.x-p.x)+Math.abs(e.y-p.y);
    if(dist<=1.5){
      // Adjacent outside battle: just stay (battle handles damage)
    } else {
      switch(e.ai){
        case 'wander': enemyWander(e);break;
        case 'chase': case 'boss': enemyChase(e,p);break;
        case 'guard': dist<10?enemyChase(e,p):enemyReturn(e);break;
      }
    }
  }
}
function moveEnemy(e,nx,ny){
  G.enemySet.delete(e.y*MAP_W+e.x);
  e.x=nx;e.y=ny;
  G.enemySet.add(ny*MAP_W+nx);
}
function enemyWander(e){
  const dirs=shuffle(Object.values(DIR));
  for(const[dx,dy]of dirs){const nx=e.x+dx,ny=e.y+dy;if(canMove(nx,ny)){moveEnemy(e,nx,ny);break;}}
}
function enemyChase(e,p){
  const dx=p.x-e.x,dy=p.y-e.y;
  const moves=[];
  if(dx!==0)moves.push([Math.sign(dx),0]);
  if(dy!==0)moves.push([0,Math.sign(dy)]);
  if(dx!==0&&dy!==0)moves.push([Math.sign(dx),Math.sign(dy)]);
  for(const[mdx,mdy]of shuffle(moves)){
    const nx=e.x+mdx,ny=e.y+mdy;
    if(canMove(nx,ny)){moveEnemy(e,nx,ny);return;}
  }
  enemyWander(e);
}
function enemyReturn(e){
  if(e.x===e.guardX&&e.y===e.guardY)return;
  const dx=e.guardX-e.x,dy=e.guardY-e.y;
  const nx=e.x+Math.sign(dx),ny=e.y+Math.sign(dy);
  if(canMove(nx,ny)) moveEnemy(e,nx,ny);
}
function canMove(nx,ny){
  if(nx<0||ny<0||nx>=MAP_W||ny>=MAP_H)return false;
  const t=G.map[ny][nx];
  if(t===T.WALL||t===T.VOID)return false;
  if(G.enemySet.has(ny*MAP_W+nx))return false;
  if(G.player.x===nx&&G.player.y===ny)return false;
  return true;
}

/* ── Status effects ──────────────────────────────────────────────────────── */
function hasStatus(ent,type){ return ent.status.some(s=>s.type===type); }
function addStatus(ent,type,dur,power=1){
  const ex=ent.status.find(s=>s.type===type);
  if(ex){ex.dur=Math.max(ex.dur,dur);}
  else ent.status.push({type,dur,power});
}
function tickStatus(ent,who){
  const msgs=[];
  for(let i=ent.status.length-1;i>=0;i--){
    const s=ent.status[i];
    if(s.type==='poison'){
      const dmg=Math.max(1,Math.round(s.power));
      ent.hp=Math.max(0,ent.hp-dmg);
      if(who==='player') msgs.push([`Poison deals ${dmg} dmg.`,COL.bPoison]);
    } else if(s.type==='burn'){
      const dmg=Math.max(1,Math.round(s.power*1.3));
      ent.hp=Math.max(0,ent.hp-dmg);
      if(who==='player') msgs.push([`Burn deals ${dmg} dmg.`,COL.bBurn]);
    } else if(s.type==='regen'){
      const heal=Math.max(1,Math.round(s.power));
      ent.hp=Math.min(ent.maxHp,ent.hp+heal);
      if(who==='player') msgs.push([`Regen restores ${heal} HP.`,COL.bHeal]);
    }
    s.dur--;
    if(s.dur<=0) ent.status.splice(i,1);
  }
  msgs.forEach(([t,c])=>msg(t,c));
  updateHUD();
}

/* ── Items ───────────────────────────────────────────────────────────────── */
function pickupItem(item){
  const p=G.player;
  if(item.type==='gold'){p.gold+=item.val;msg(`+${item.val} gold`,COL.gold);}
  else if(item.type==='potion'){const h=Math.min(item.val,p.maxHp-p.hp);p.hp+=h;msg(`Potion: +${h} HP`,'#ff4466');spawnDmgP(p.x,p.y,`+${h}HP`,'#ff4466');}
  else if(item.type==='weapon'){
    const w=WEAPONS[item.weaponIdx];
    if(item.weaponIdx>p.weaponIdx){msg(`Equipped ${w.name}!`,COL.wpn);p.weaponIdx=item.weaponIdx;}
    else{msg(`Found ${w.name} — sold for 3g`);p.gold+=3;}
  } else if(item.type==='elixir'){p.maxHp+=2;p.hp+=2;msg('Elixir: +2 max HP!','#ff88cc');spawnDmgP(p.x,p.y,'+2 MaxHP','#ff88cc');}
  updateHUD();
}
function openChest(x,y){
  const p=G.player;
  const gold=4+Math.floor(Math.random()*8)+p.floor*2;
  p.gold+=gold;msg(`Chest: +${gold} gold!`,COL.stairs);spawnDmgP(x,y,`+${gold}g`,'#ffcc00');
  if(Math.random()<.45){const h=Math.round(p.maxHp*.3);p.hp=Math.min(p.maxHp,p.hp+h);msg(`Also: +${h}HP`,'#ff4466');}
  updateHUD();
}
function nextFloor(){
  const f=G.player.floor+1;
  msg(`Descending to floor ${f}…`,COL.stairs);
  saveBest(G.player);
  if(f>10){
    // Victory — show ending, then loop dungeon deeper
    DLG.show(LORE.victory,()=>{
      msg('KAEL is gone. But the dungeon remains...',COL.stairs);
      loadFloor(f);
    },false);
  } else {
    loadFloor(f);
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   SHOP
══════════════════════════════════════════════════════════════════════════════ */
function openShop(){
  G.shopOpen=true;
  G.phase='shop';
  resizeCanvas();
  const quip=LORE.merchant[Math.floor(Math.random()*LORE.merchant.length)];
  DLG.show(['  KAEL\'S DUNGEON EMPORIUM','  ─────────────────────────','',`  ${quip}`,'',' [ TAP / ANY KEY to browse ]'],()=>{
    renderShopUI();
  },true);
  msg('You enter the merchant\'s alcove.',COL.shop);
}
function closeShop(){
  G.shopOpen=false;
  G.phase='player';
  resizeCanvas();
  computeFOV();centerCamera();endPlayerTurn();
}

function shopItems(){
  const p=G.player;
  const f=p.floor;
  const items=[
    {id:'potion',  name:'Health Potion', desc:`Restore 40% HP`, cost:8+f*2,  col:'#ff4466'},
    {id:'bigpot',  name:'Mega Potion',   desc:`Restore 80% HP`, cost:18+f*3, col:'#ff88aa'},
    {id:'upgrade', name:'Sharpen Blade', desc:'+2 ATK perm',    cost:20+f*4, col:COL.wpn},
    {id:'armor',   name:'Reinforce Armor',desc:'+1 DEF perm',   cost:15+f*3, col:'#aabbcc'},
    {id:'regen',   name:'Regen Salve',   desc:'Regen 3 HP/turn (5 turns)',cost:12+f*2,col:COL.bHeal},
  ];
  // Revive (only if near death)
  if(p.hp<p.maxHp*.4) items.push({id:'revive',name:'Life Crystal',desc:'Restore to full HP',cost:30+f*5,col:'#ffccff'});
  return items;
}

function renderShopUI(){
  const ui=$('shop-ui');
  if(!ui)return;
  ui.innerHTML='';
  const p=G.player;
  const hdr=document.createElement('div');
  hdr.className='shop-header';
  hdr.innerHTML=`<span>🏪 MERCHANT  (⬡${p.gold})</span><button class="shop-close" id="shop-close-btn">LEAVE</button>`;
  ui.appendChild(hdr);
  $('shop-close-btn').onclick=closeShop;
  const row=document.createElement('div');row.className='shop-items-row';ui.appendChild(row);
  shopItems().forEach((item,i)=>{
    const btn=document.createElement('button');
    btn.className='shop-item-btn'+(p.gold<item.cost?' cant-afford':'');
    btn.innerHTML=`<span style="color:${item.col}">${item.name}</span><br><span class="shop-desc">${item.desc}</span><br><span class="shop-cost">⬡${item.cost}</span>`;
    btn.addEventListener('click',()=>buyShopItem(item));
    btn.addEventListener('touchstart',e=>{e.preventDefault();buyShopItem(item);},{passive:false});
    row.appendChild(btn);
  });
}
function buyShopItem(item){
  const p=G.player;
  if(p.gold<item.cost){msg('Not enough gold!','#ff4422');return;}
  p.gold-=item.cost;
  if(item.id==='potion'){const h=Math.round(p.maxHp*.4);p.hp=Math.min(p.maxHp,p.hp+h);msg(`Potion: +${h} HP`,item.col);}
  else if(item.id==='bigpot'){const h=Math.round(p.maxHp*.8);p.hp=Math.min(p.maxHp,p.hp+h);msg(`Mega Potion: +${h} HP`,item.col);}
  else if(item.id==='upgrade'){p.atk+=2;msg('+2 ATK permanently!',item.col);}
  else if(item.id==='armor'){p.def+=1;msg('+1 DEF permanently!',item.col);}
  else if(item.id==='regen'){addStatus(p,'regen',5,3);msg('Regen active for 5 turns!',item.col);}
  else if(item.id==='revive'){p.hp=p.maxHp;msg('Full HP restored!',item.col);}
  updateHUD();renderShopUI();
}
function handleShopKey(key){
  if(key==='Escape'||key==='x'||key==='q') closeShop();
}

/* ══════════════════════════════════════════════════════════════════════════════
   LEVEL-UP CHOICE
══════════════════════════════════════════════════════════════════════════════ */
function showLevelUpChoice(){
  G.player.pendingLevelUp=false;
  G.phase='levelup';
  renderLevelUpUI();
}
function renderLevelUpUI(){
  const ui=$('levelup-ui');
  if(!ui)return;
  ui.style.display='flex';
  ui.innerHTML=`<div class="lu-title">★ LEVEL UP! Choose a stat:</div>`;
  const opts=[
    {id:'hp',  label:'+8 Max HP', col:'#44ff88'},
    {id:'atk', label:'+2 Attack', col:'#ff8844'},
    {id:'def', label:'+2 Defense',col:'#88aaff'},
  ];
  opts.forEach(o=>{
    const btn=document.createElement('button');
    btn.className='lu-btn';btn.style.borderColor=o.col;btn.style.color=o.col;
    btn.textContent=o.label;
    btn.addEventListener('click',()=>applyLevelUp(o.id));
    btn.addEventListener('touchstart',e=>{e.preventDefault();applyLevelUp(o.id);},{passive:false});
    ui.appendChild(btn);
  });
}
function applyLevelUp(stat){
  const p=G.player;
  if(stat==='hp'){p.maxHp+=8;p.hp=Math.min(p.maxHp,p.hp+8);msg(`Max HP +8 → ${p.maxHp}`,'#44ff88');}
  else if(stat==='atk'){p.atk+=2;msg(`ATK +2 → ${p.atk}`,'#ff8844');}
  else if(stat==='def'){p.def+=2;msg(`DEF +2 → ${p.def}`,'#88aaff');}
  $('levelup-ui').style.display='none';
  G.phase='player';
  updateHUD();
}
function handleLevelUpKey(key){
  if(key==='1') applyLevelUp('hp');
  else if(key==='2') applyLevelUp('atk');
  else if(key==='3') applyLevelUp('def');
}

/* ══════════════════════════════════════════════════════════════════════════════
   BATTLE — ENTER / EXIT
══════════════════════════════════════════════════════════════════════════════ */
function enterBattle(enemy){
  G.phase='battle';
  G.battle=freshBattle(enemy);
  G.player.defending=false;
  battleLog(`${enemy.name} attacks! [HP:${enemy.hp}]`);
  battleLog('Choose your action.',COL.bDim);
  resizeCanvas();
  updateBattleUI();
  // First encounter taunt
  const pool=LORE.taunts[enemy.name];
  if(pool&&!DLG.taunted.has(enemy.name)){
    DLG.taunted.add(enemy.name);
    const line=pool[Math.floor(Math.random()*pool.length)];
    DLG.show(['',`  ${enemy.name.toUpperCase()} ENCOUNTER`,'',`  "${line}"`,'',' [ TAP / ANY KEY ]'],null,true);
  }
}
function exitBattle(won){
  G.battle=null;
  G.phase='player';
  resizeCanvas();
  updateHUD();
  if(won){computeFOV();centerCamera();}
}

/* ── Battle UI ────────────────────────────────────────────────────────────── */
function updateBattleUI(){
  const b=G.battle;
  const ui=$('battle-ui');
  ui.innerHTML='';
  if(!b||b.phase!=='choose')return;
  const p=G.player;
  SKILLS.forEach((sk,i)=>{
    const btn=document.createElement('button');
    const disabled=(sk.id==='heal'&&b.healUsed>=3);
    btn.className='battle-btn'+(i===b.selectedSkill?' selected':'')+(disabled?' disabled':'');
    let extra='';
    if(sk.id==='heal') extra=b.healUsed>0?` (${3-b.healUsed} left)`:'';
    btn.innerHTML=`<span class="bk">${sk.key}</span><span class="sk-name">${sk.name}${extra}</span><span class="sk-desc">${sk.desc}</span>`;
    if(!disabled){
      btn.addEventListener('click',()=>playerBattleAction(i));
      btn.addEventListener('touchstart',e=>{e.preventDefault();playerBattleAction(i);},{passive:false});
    }
    ui.appendChild(btn);
  });
}

/* ── Battle input ─────────────────────────────────────────────────────────── */
function handleBattleKey(key){
  const b=G.battle;
  if(!b||b.phase!=='choose')return;
  const idx={'1':0,'2':1,'3':2,'4':3,'5':4,'6':5}[key];
  if(idx!==undefined){playerBattleAction(idx);return;}
  if(key==='ArrowUp'||key==='w'){b.selectedSkill=(b.selectedSkill-1+SKILLS.length)%SKILLS.length;updateBattleUI();}
  else if(key==='ArrowDown'||key==='s'){b.selectedSkill=(b.selectedSkill+1)%SKILLS.length;updateBattleUI();}
  else if(key==='Enter'||key===' ') playerBattleAction(b.selectedSkill);
}

/* ── Battle: player action ────────────────────────────────────────────────── */
function playerBattleAction(skillIdx){
  const b=G.battle;
  if(!b||b.phase!=='choose')return;
  const bid=b.id; // capture for stale-closure check
  const p=G.player;
  const e=b.enemy;
  const sk=SKILLS[skillIdx];
  b.phase='animate';
  $('battle-ui').innerHTML='';

  /* FLEE */
  if(sk.id==='flee'){
    const pct=Math.min(80,30+p.level*8);
    if(Math.random()*100<pct){
      battleLog('Escaped successfully!',COL.bGood);
      b.resultText='FLED!';b.resultTimer=55;b.phase='result';
      setTimeout(()=>{if(G.battle?.id===bid)exitBattle(false);},800);
    } else {
      battleLog("Can't escape!",COL.bBad);b.playerShake=10;
      setTimeout(()=>{if(G.battle?.id===bid)enemyTurn(bid);},350);
    }
    return;
  }

  /* DEFEND */
  if(sk.id==='defend'){
    p.defending=true;
    battleLog('You brace! Damage halved this round.',COL.bGood);
    b.playerFlash=12;b.playerFlashCol='#4488ff';
    setTimeout(()=>{if(G.battle?.id===bid)enemyTurn(bid);},500);
    return;
  }

  /* HEAL */
  if(sk.id==='heal'){
    if(b.healUsed>=3){battleLog('Heal exhausted!',COL.bBad);b.phase='choose';updateBattleUI();return;}
    b.healUsed++;
    const base=Math.round(p.maxHp*.25);
    const heal=Math.min(base,p.maxHp-p.hp);
    p.hp=Math.min(p.maxHp,p.hp+heal);
    battleLog(`You heal for ${heal} HP.`,COL.bHeal);
    b.playerFlash=14;b.playerFlashCol=COL.bHeal;
    updateHUD();
    setTimeout(()=>{if(G.battle?.id===bid)enemyTurn(bid);},500);
    return;
  }

  /* ATTACK / QUICKSTRIKE / HEAVY */
  const totalAtk=p.atk+WEAPONS[p.weaponIdx].atk;
  const critChance=WEAPONS[p.weaponIdx].crit+(p.level*.005);

  function calcHit(mult=1){
    const isCrit=Math.random()<critChance;
    const variance=Math.floor(Math.random()*4)-1;
    const raw=Math.max(1,Math.round((totalAtk-e.def+variance)*mult));
    return {dmg:isCrit?Math.round(raw*1.8):raw, isCrit};
  }

  if(sk.id==='attack'){
    const {dmg,isCrit}=calcHit(1);
    e.hp=Math.max(0,e.hp-dmg);
    b.enemyShake=14;b.enemyFlash=16;b.enemyFlashCol=COL.bHit;
    battleLog(`${isCrit?'CRITICAL! ':''}You hit for ${dmg} dmg.`,isCrit?COL.bCrit:COL.bText);
    if(isCrit){spawnBattleEffect('CRIT!',COL.bCrit);}
  } else if(sk.id==='quick'){
    const h1=calcHit(.6),h2=calcHit(.6);
    e.hp=Math.max(0,e.hp-h1.dmg-h2.dmg);
    b.enemyShake=18;b.enemyFlash=20;b.enemyFlashCol=COL.bHit;
    battleLog(`Quick hits: ${h1.dmg}+${h2.dmg}=${h1.dmg+h2.dmg} dmg.`,COL.bText);
  } else if(sk.id==='heavy'){
    const {dmg,isCrit}=calcHit(1.8);
    e.hp=Math.max(0,e.hp-dmg);
    b.enemyShake=24;b.enemyFlash=26;b.enemyFlashCol=COL.bHit;
    battleLog(`HEAVY BLOW: ${isCrit?'CRIT! ':''}${dmg} dmg! (you lose next turn)`,isCrit?COL.bCrit:COL.bHit);
    b.skipNextTurn=true;
    if(isCrit) spawnBattleEffect('CRIT!',COL.bCrit);
  }

  p.totalDmgDealt=(p.totalDmgDealt||0)+(totalAtk);

  if(e.hp<=0){
    killEnemy(e,bid);return;
  }

  setTimeout(()=>{if(G.battle?.id===bid)enemyTurn(bid);},sk.id==='quick'?350:480);
}

function killEnemy(e,bid){
  const b=G.battle;
  const p=G.player;
  battleLog(`${e.name} defeated! +${e.xp}xp +${e.gold}g`,COL.bGood);
  p.xp+=e.xp; p.gold+=e.gold; p.kills++;
  G.enemies=G.enemies.filter(en=>en!==e);
  G.enemySet.delete(e.y*MAP_W+e.x);
  checkXPLevel();
  b.resultText='VICTORY!';b.resultTimer=70;b.phase='result';
  updateHUD();
  setTimeout(()=>{if(G.battle?.id===bid)exitBattle(true);},1000);
}

/* ── Battle: enemy turn ───────────────────────────────────────────────────── */
function enemyTurn(bid){
  const b=G.battle;
  if(!b||b.id!==bid) return; // stale call
  const p=G.player;
  const e=b.enemy;
  b.phase='enemy';

  // Tick enemy status
  tickStatus(e,'enemy');
  if(e.hp<=0){killEnemy(e,bid);return;}

  // Stun: skip turn
  if(hasStatus(e,'stun')){
    battleLog(`${e.name} is stunned!`,COL.bStun);
    setTimeout(()=>{if(G.battle?.id===bid)afterEnemyTurn(bid);},400);
    return;
  }

  const action=e.actions[Math.floor(Math.random()*e.actions.length)];
  const effDef=p.defending?Math.round(p.def*2):p.def;
  p.defending=false;

  // Dodge check
  if(Math.random()<p.dodge&&action==='atk'){
    battleLog('You dodge the attack!',COL.bGood);
    setTimeout(()=>{if(G.battle?.id===bid)afterEnemyTurn(bid);},400);
    return;
  }

  switch(action){
    case 'atk':{
      const dmg=Math.max(0,e.atk-effDef+Math.floor(Math.random()*3)-1);
      p.hp=Math.max(0,p.hp-dmg);
      battleLog(`${e.name} attacks for ${dmg}.`,COL.bBad);
      b.playerShake=12;b.playerFlash=14;b.playerFlashCol=COL.bBad;
      break;}
    case 'pow':{
      const dmg=Math.max(0,Math.round(e.atk*1.7)-effDef+Math.floor(Math.random()*4)-1);
      p.hp=Math.max(0,p.hp-dmg);
      battleLog(`${e.name} POWER STRIKES for ${dmg}!`,COL.bBad);
      b.playerShake=20;b.playerFlash=20;b.playerFlashCol='#ff2200';
      break;}
    case 'spc':{
      const dmg=Math.max(1,Math.round(e.atk*1.4)-Math.floor(effDef/2)+Math.floor(Math.random()*5));
      p.hp=Math.max(0,p.hp-dmg);
      battleLog(`${e.name} casts DARK BOLT: ${dmg}!`,COL.bMagic);
      b.playerShake=22;b.playerFlash=22;b.playerFlashCol=COL.bMagic;
      break;}
    case 'psn':{
      const dmg=Math.max(1,e.atk-effDef);p.hp=Math.max(0,p.hp-dmg);
      addStatus(p,'poison',4,Math.round(e.atk*.35));
      battleLog(`${e.name} poisons you! (${dmg}+DoT)`,COL.bPoison);
      b.playerShake=14;b.playerFlash=14;b.playerFlashCol=COL.bPoison;
      break;}
    case 'burn':{
      const dmg=Math.max(1,e.atk-effDef);p.hp=Math.max(0,p.hp-dmg);
      addStatus(p,'burn',3,Math.round(e.atk*.4));
      battleLog(`${e.name} ignites you! (${dmg}+Burn)`,COL.bBurn);
      b.playerShake=16;b.playerFlash=16;b.playerFlashCol=COL.bBurn;
      break;}
    case 'stun':{
      const dmg=Math.max(1,e.atk-effDef);p.hp=Math.max(0,p.hp-dmg);
      addStatus(p,'stun',2,0);
      battleLog(`${e.name} stuns you! (skip next turn)`,COL.bStun);
      b.playerShake=18;b.playerFlash=18;b.playerFlashCol=COL.bStun;
      break;}
  }
  updateHUD();

  if(p.hp<=0){
    battleLog('You have been slain…','#ff4422');
    b.resultText='DEFEATED';b.resultTimer=80;b.phase='result';
    setTimeout(()=>{if(G.battle?.id===bid){G.battle=null;playerDies();}},1100);
    return;
  }
  setTimeout(()=>{if(G.battle?.id===bid)afterEnemyTurn(bid);},500);
}

function afterEnemyTurn(bid){
  const b=G.battle;
  if(!b||b.id!==bid)return;
  if(b.skipNextTurn){
    b.skipNextTurn=false;
    battleLog('Exhausted — enemy acts again!','#ffaa44');
    setTimeout(()=>{if(G.battle?.id===bid)enemyTurn(bid);},300);
    return;
  }
  // Check player stun
  if(hasStatus(G.player,'stun')){
    battleLog('You are stunned — skip your turn!',COL.bStun);
    setTimeout(()=>{if(G.battle?.id===bid)enemyTurn(bid);},300);
    return;
  }
  b.phase='choose';
  battleLog('Your turn.',COL.bDim);
  updateBattleUI();
}

function battleLog(text,color=COL.bText){
  const b=G.battle;if(!b)return;
  b.log.unshift({text,color});
  if(b.log.length>6) b.log.length=6;
}

let battleEffects=[];
function spawnBattleEffect(text,color){
  battleEffects.push({text,color,life:1.2,maxLife:1.2,y:0.2});
}

/* ── XP / Level up ───────────────────────────────────────────────────────── */
function checkXPLevel(){
  const p=G.player;
  while(p.xp>=p.xpNext){
    p.xp-=p.xpNext;
    p.level++;
    p.xpNext=Math.round(p.xpNext*1.4);
    p.pendingLevelUp=true;
    msg(`★ LEVEL ${p.level}!`,COL.stairs);
    if(G.phase==='battle'&&G.battle) battleLog(`★ LEVEL UP! LV${p.level}`,COL.stairs);
  }
}

/* ── Death ───────────────────────────────────────────────────────────────── */
function playerDies(){
  G.phase='dead';
  saveBest(G.player);updateTitleBest();
  const p=G.player;
  const eulogy=LORE.eulogies[Math.floor(Math.random()*LORE.eulogies.length)];
  // Populate death screen now, show it after eulogy dismissed
  $('dead-msg').textContent=`Slain on floor ${p.floor} — level ${p.level} — ${p.kills} kills.`;
  $('dead-stats').innerHTML=[
    {v:p.floor,l:'FLOOR'},{v:p.kills,l:'KILLS'},
    {v:p.gold,l:'GOLD'},{v:p.level,l:'LEVEL'},
    {v:p.xp,l:'XP'},{v:p.totalDmgDealt||0,l:'DMG DEALT'},
  ].map(s=>`<div class="ds-box"><div class="ds-val">${s.v}</div><div class="ds-lbl">${s.l}</div></div>`).join('');
  $('dead-hs').innerHTML=`BEST FLOOR: ${getBestFloor()} &nbsp;|&nbsp; BEST SCORE: ${getBestScore()}`;
  resizeCanvas();
  DLG.show(
    ['  † REQUIESCAT IN PACE †','',...eulogy.split('\n').map(l=>`  ${l}`),'',`  Floor:${p.floor}  Lv:${p.level}  Kills:${p.kills}`,'',' [ TAP / ANY KEY ]'],
    ()=>showScreen('screen-dead'),
    false
  );
}

/* ── Particles ───────────────────────────────────────────────────────────── */
function spawnDmgP(tx,ty,text,color){
  if(!G)return;
  G.particles.push({wx:tx+.5,wy:ty-.2,text:String(text),color,vy:-.02,life:1.3,maxLife:1.3});
}
function tickParticles(dt){
  DLG.tick(dt);
  for(let i=G.particles.length-1;i>=0;i--){
    const p=G.particles[i];p.life-=dt;p.wy+=p.vy;
    if(p.life<=0)G.particles.splice(i,1);
  }
  for(let i=battleEffects.length-1;i>=0;i--){
    const e=battleEffects[i];e.life-=dt;e.y-=dt*.15;
    if(e.life<=0)battleEffects.splice(i,1);
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   MAIN LOOP
══════════════════════════════════════════════════════════════════════════════ */
let lastTs=0;
function loop(ts){
  animId=requestAnimationFrame(loop);
  const dt=Math.min((ts-lastTs)/1000,.05);lastTs=ts;
  if(!G||G.phase==='dead')return;
  tickParticles(dt);
  if(G.phase==='battle') tickBattleAnim(dt);
  draw();
}

function tickBattleAnim(dt){
  const b=G.battle;if(!b)return;
  if(b.playerShake>0)b.playerShake--;
  if(b.enemyShake>0)b.enemyShake--;
  if(b.playerFlash>0)b.playerFlash--;
  if(b.enemyFlash>0)b.enemyFlash--;
  if(b.resultTimer>0)b.resultTimer--;
  b.playerBob+=dt*2.0;
  b.enemyBob+=dt*1.7;
}

/* ══════════════════════════════════════════════════════════════════════════════
   DRAW ROUTER
══════════════════════════════════════════════════════════════════════════════ */
function draw(){
  if(G.phase==='battle'||G.battle) drawBattle();
  else drawDungeon();
  if(DLG.isActive()) DLG.draw(ctx,canvas.width,canvas.height);
}

/* ══════════════════════════════════════════════════════════════════════════════
   DRAW — DUNGEON (uses offscreen layer)
══════════════════════════════════════════════════════════════════════════════ */
function drawDungeon(){
  const camX=OX,camY=OY;

  // Rebuild offscreen layer if needed
  if(dungeonDirty) buildDungeonLayer();
  if(dungeonLayer) ctx.drawImage(dungeonLayer,0,0);
  else{ctx.fillStyle=COL.void;ctx.fillRect(0,0,canvas.width,canvas.height);}

  // Items (dynamic — not cached)
  for(const item of G.items){
    if(G.vis[item.y]?.[item.x]!==V.VISIBLE)continue;
    const px=(item.x-camX)*TILE,py=(item.y-camY)*TILE;
    drawCh(px,py,item.type==='gold'?'$':item.type==='potion'?'!':item.type==='elixir'?'♥':WEAPONS[item.weaponIdx]?.sym||'?',
      item.type==='gold'?COL.gold:item.type==='potion'?COL.potion:item.type==='elixir'?'#ff88cc':COL.wpn,12);
  }

  // Enemies
  for(const e of G.enemies){
    if(G.vis[e.y]?.[e.x]!==V.VISIBLE)continue;
    const px=(e.x-camX)*TILE,py=(e.y-camY)*TILE;
    // Status glow
    if(hasStatus(e,'stun')){ctx.fillStyle='rgba(255,255,64,.15)';ctx.fillRect(px,py,TILE,TILE);}
    if(hasStatus(e,'poison')){ctx.fillStyle='rgba(128,255,64,.12)';ctx.fillRect(px,py,TILE,TILE);}
    drawCh(px,py,e.sym,e.col,13);
    // Tiny HP bar
    const bw=TILE-2,bx=px+1,by=py-3;
    ctx.fillStyle='#330000';ctx.fillRect(bx,by,bw,2);
    ctx.fillStyle=e.col;ctx.fillRect(bx,by,Math.round(bw*Math.max(0,e.hp/e.maxHp)),2);
  }

  // Player
  const pp=G.player;
  const ppx=(pp.x-camX)*TILE,ppy=(pp.y-camY)*TILE;
  // Status aura
  if(hasStatus(pp,'regen')){ctx.fillStyle='rgba(64,255,128,.12)';ctx.fillRect(ppx-1,ppy-1,TILE+2,TILE+2);}
  if(hasStatus(pp,'poison')){ctx.fillStyle='rgba(128,255,64,.15)';ctx.fillRect(ppx-1,ppy-1,TILE+2,TILE+2);}
  ctx.fillStyle='rgba(255,238,136,.06)';ctx.fillRect(ppx-2,ppy-2,TILE+4,TILE+4);
  drawCh(ppx,ppy,'@',COL.player,13);
  if(pp.weaponIdx>0){const w=WEAPONS[pp.weaponIdx];drawCh(ppx+9,ppy-4,w.sym,w.col,8);}

  // Particles
  ctx.save();ctx.textAlign='center';ctx.textBaseline='middle';
  for(const p of G.particles){
    ctx.globalAlpha=Math.min(1,p.life/p.maxLife*2);
    ctx.fillStyle=p.color;
    ctx.font=`bold ${Math.round(TILE*.55)}px VT323,monospace`;
    ctx.fillText(p.text,(p.wx-camX)*TILE+TILE/2,(p.wy-camY)*TILE);
  }
  ctx.globalAlpha=1;ctx.restore();

  drawMinimap();
}

function drawCh(px,py,ch,color,size=12){
  ctx.fillStyle=color;
  ctx.font=`${size}px VT323,monospace`;
  ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillText(ch,px+TILE/2,py+TILE/2+1);
}

function drawMinimap(){
  const S=2,mx=canvas.width-MAP_W*S-6,my=6;
  ctx.fillStyle='rgba(0,0,0,.72)';ctx.fillRect(mx-2,my-2,MAP_W*S+4,MAP_H*S+4);
  for(let y=0;y<MAP_H;y++) for(let x=0;x<MAP_W;x++){
    const vis=G.vis[y][x];if(vis===V.UNSEEN)continue;
    const t=G.map[y][x];
    const th=getTheme(G.player.floor);
    let c=vis===V.VISIBLE?th.floor2:'#0e0c00';
    if(t===T.WALL)c=vis===V.VISIBLE?th.wallhi:'#1a1000';
    else if(t===T.STAIRS)c=COL.stairs;
    else if(t===T.CHEST)c=COL.chest;
    else if(t===T.SHOP)c=COL.shop;
    ctx.fillStyle=c;ctx.fillRect(mx+x*S,my+y*S,S,S);
  }
  for(const e of G.enemies) if(G.vis[e.y]?.[e.x]===V.VISIBLE){
    ctx.fillStyle=e.col;ctx.fillRect(mx+e.x*S,my+e.y*S,S,S);
  }
  ctx.fillStyle=COL.player;ctx.fillRect(mx+G.player.x*S,my+G.player.y*S,S,S);
}

/* ══════════════════════════════════════════════════════════════════════════════
   DRAW — BATTLE SCREEN
══════════════════════════════════════════════════════════════════════════════ */
function drawBattle(){
  const W=canvas.width,H=canvas.height;
  const b=G.battle;
  if(!b)return;
  const p=G.player,e=b.enemy;

  // BG gradient
  const grad=ctx.createLinearGradient(0,0,0,H);
  grad.addColorStop(0,'#0e0b00');grad.addColorStop(1,'#180e00');
  ctx.fillStyle=grad;ctx.fillRect(0,0,W,H);

  // Pre-baked scanlines
  if(scanlineLayer) ctx.drawImage(scanlineLayer,0,0);

  // Border
  ctx.strokeStyle=COL.bBord;ctx.lineWidth=2;ctx.strokeRect(5,5,W-10,H-10);
  ctx.strokeStyle='rgba(255,160,0,.07)';ctx.lineWidth=1;ctx.strokeRect(9,9,W-18,H-18);

  const cx=W/2,theme=getTheme(p.floor);

  // Theme-coloured background strip
  ctx.fillStyle=theme.floor+'88';
  ctx.fillRect(0,H*.12,W,H*.6);

  // VS
  ctx.fillStyle='rgba(255,179,0,.1)';
  ctx.font=`bold 56px VT323,monospace`;
  ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillText('VS',cx,H*.38);

  // Panel layout
  const maxPW=Math.min(W*.44,200);
  const pH=Math.min(H*.48,180);
  const pTopY=H*.04;
  const pPanel=cx-maxPW-16;
  const ePanel=cx+16;

  // Enemy shake
  const eSX=b.enemyShake>0?(Math.random()-.5)*7:0;
  const eSY=b.enemyShake>0?(Math.random()-.5)*4:0;
  drawBattlePanel(ePanel+eSX,pTopY+eSY+Math.sin(b.enemyBob)*3,
    maxPW,pH,e.name,e.hp,e.maxHp,e.col,e.sprite||[e.sym],
    b.enemyFlash>0,b.enemyFlashCol,false,e.status);

  // Player shake
  const pSX=b.playerShake>0?(Math.random()-.5)*5:0;
  const pSY=b.playerShake>0?(Math.random()-.5)*3:0;
  const wep=WEAPONS[p.weaponIdx];
  drawBattlePanel(pPanel+pSX,pTopY+pSY+Math.sin(b.playerBob)*2,
    maxPW,pH,`LV${p.level} ${wep.name}`,p.hp,p.maxHp,COL.player,
    p.weaponIdx>0?[[wep.sym],['@']]:['@','@','@'],
    b.playerFlash>0,b.playerFlashCol,true,p.status);

  // Battle log box
  const logY=pTopY+pH+26;
  const logH=H-logY-14;
  ctx.fillStyle='rgba(0,0,0,.6)';
  rrCtx(ctx,14,logY,W-28,logH,4);ctx.fill();
  ctx.strokeStyle=COL.bBord;ctx.lineWidth=1;
  rrCtx(ctx,14,logY,W-28,logH,4);ctx.stroke();

  const maxLH=Math.min(22,logH/5);
  ctx.textAlign='left';ctx.textBaseline='top';
  const maxLines=Math.floor(logH/maxLH);
  b.log.slice(0,maxLines).forEach((entry,i)=>{
    ctx.globalAlpha=i===0?1:(1-i/b.log.length)*.75+.1;
    ctx.fillStyle=entry.color||COL.bText;
    ctx.font=`${Math.max(12,maxLH*.78)}px VT323,monospace`;
    ctx.fillText((i===0?'▶ ':' · ')+entry.text,20,logY+4+i*maxLH);
  });
  ctx.globalAlpha=1;

  // Battle floating effects (CRIT!, etc.)
  battleEffects.forEach(ef=>{
    ctx.globalAlpha=Math.min(1,ef.life/ef.maxLife*2);
    ctx.fillStyle=ef.color;
    ctx.font=`bold 28px VT323,monospace`;
    ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.fillText(ef.text,cx,H*(ef.y+.1));
  });
  ctx.globalAlpha=1;

  // Result banner
  if(b.resultTimer>0&&b.resultText){
    const a=Math.min(1,b.resultTimer/16);
    ctx.globalAlpha=a;
    const rcol=b.resultText==='VICTORY!'?COL.bGood:b.resultText==='FLED!'?COL.stairs:'#ff3322';
    ctx.fillStyle=rcol;
    ctx.font=`bold ${Math.min(52,W*.12)}px VT323,monospace`;
    ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.fillText(b.resultText,cx,H*.46);
    ctx.globalAlpha=1;
  }
}

function drawBattlePanel(x,y,w,h,name,hp,maxHp,color,sprite,flashing,flashCol,isPlayer,statuses){
  ctx.save();
  ctx.fillStyle=COL.bPanel;rrCtx(ctx,x,y,w,h,4);ctx.fill();
  ctx.strokeStyle=flashing?flashCol:COL.bBord;ctx.lineWidth=flashing?2.5:1;
  rrCtx(ctx,x,y,w,h,4);ctx.stroke();
  if(flashing){ctx.fillStyle=flashCol+'2a';rrCtx(ctx,x,y,w,h,4);ctx.fill();}

  const sprH=h*.58,sprY=y+5,sCx=x+w/2,sCy=sprY+sprH/2;
  ctx.fillStyle='rgba(0,0,0,.4)';rrCtx(ctx,x+3,sprY,w-6,sprH,3);ctx.fill();

  // Multi-line sprite
  const spriteLines=Array.isArray(sprite[0])?sprite:sprite; // already array of strings
  const fontSize=Math.min(sprH/(spriteLines.length+1)*1.1,w*.38);
  ctx.fillStyle=flashing?flashCol:color;
  ctx.font=`${fontSize}px VT323,monospace`;
  ctx.textAlign='center';ctx.textBaseline='middle';
  spriteLines.forEach((line,i)=>{
    const lineStr=Array.isArray(line)?line.join(''):line;
    ctx.fillText(lineStr,sCx,sCy+(i-(spriteLines.length-1)/2)*(fontSize+2));
  });

  // HP bar
  const barY=y+sprH+8,barH=8,barX=x+5,barW=w-10;
  const pct=Math.max(0,hp/maxHp);
  ctx.fillStyle='#1a0800';ctx.fillRect(barX,barY,barW,barH);
  const bc=pct>.5?'#44ff66':pct>.25?'#ffcc00':'#ff3322';
  ctx.fillStyle=bc;ctx.fillRect(barX,barY,Math.round(barW*pct),barH);
  ctx.strokeStyle='rgba(255,179,0,.18)';ctx.lineWidth=1;ctx.strokeRect(barX,barY,barW,barH);

  // HP text
  ctx.fillStyle=bc;ctx.font=`12px VT323,monospace`;
  ctx.textAlign='center';ctx.textBaseline='top';
  ctx.fillText(`${Math.max(0,hp)}/${maxHp}`,x+w/2,barY+10);

  // Status icons
  if(statuses&&statuses.length){
    const icons=statuses.map(s=>s.type==='poison'?'☠':s.type==='burn'?'*':s.type==='stun'?'!':s.type==='regen'?'+':'?');
    ctx.fillStyle=COL.bDim;ctx.font='11px VT323,monospace';
    ctx.textAlign='left';ctx.textBaseline='top';
    ctx.fillText(icons.join(' '),x+4,y+4);
  }

  // Name
  ctx.fillStyle=flashing?flashCol:color;
  ctx.font=`${Math.max(10,w*.072)}px VT323,monospace`;
  ctx.textAlign='center';ctx.textBaseline='bottom';
  ctx.fillText(name,x+w/2,y+h-2);
  ctx.restore();
}

function rrCtx(c,x,y,w,h,r){
  c.beginPath();c.moveTo(x+r,y);
  c.lineTo(x+w-r,y);c.arcTo(x+w,y,x+w,y+r,r);
  c.lineTo(x+w,y+h-r);c.arcTo(x+w,y+h,x+w-r,y+h,r);
  c.lineTo(x+r,y+h);c.arcTo(x,y+h,x,y+h-r,r);
  c.lineTo(x,y+r);c.arcTo(x,y,x+r,y,r);
  c.closePath();
}

/* ── Title ───────────────────────────────────────────────────────────────── */
window.addEventListener('load',()=>{
  $('title-art').textContent=
    ' ██████╗██████╗ ██╗   ██╗██████╗ ████████╗███████╗\n'+
    '██╔════╝██╔══██╗╚██╗ ██╔╝██╔══██╗╚══██╔══╝██╔════╝\n'+
    '██║     ██████╔╝ ╚████╔╝ ██████╔╝   ██║   ███████╗\n'+
    '██║     ██╔══██╗  ╚██╔╝  ██╔═══╝    ██║   ╚════██║\n'+
    '╚██████╗██║  ██║   ██║   ██║        ██║   ███████║\n'+
    ' ╚═════╝╚═╝  ╚═╝   ╚═╝   ╚═╝        ╚═╝   ╚══════╝';
  updateTitleBest();
});
