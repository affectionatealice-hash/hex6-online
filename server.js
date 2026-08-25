"use strict";
/* 6x6 战棋 · 权威服务器 v2
   完整状态只存在于服务器内存中，每个玩家收到删减后的视图。 */

const http = require("http");
const fs   = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const N = 6;
const MAX_DRAWS = 5;        // 每局每人最多抽 5 张
const RAGE_BONUS = 2;       // 愤怒士兵格挡后的攻击加成
const RAGE_CAP  = 7;        // 加成后攻击力上限
const STALEMATE = 6;        // 连续 pass 达到此数判和局
const HEAL_PER_TURN = 2;    // 单个单位每回合最多回复的血量（多个医疗兵不叠加）

/* ---------------- 规则数据 ---------------- */
const T = {
  SOLDIER : { n:"普通士兵", i:"🗡️", hp:10, def:3,  atk:3, rng:"adj" },
  ANGRY   : { n:"愤怒士兵", i:"😡", hp:10, def:3,  atk:5, rng:"adj", sk:"block" },
  SHIELD  : { n:"盾兵",    i:"🛡️", hp:10, def:10, atk:3, rng:"adj" },
  ARCHER  : { n:"弓箭手",  i:"🏹", hp:10, def:3,  atk:4, rng:"line" },
  NINJA   : { n:"忍者",    i:"🥷", hp:10, def:0,  atk:4, rng:"adj", sk:"dodge" },
  DOCTOR  : { n:"医疗兵",  i:"⚕️", hp:10, def:0,  atk:0, rng:"none", sk:"heal" },
  FIREBALL: { n:"火球",    i:"🔥", spell:true },
  MINE    : { n:"地雷",    i:"💣", spell:true }
};
const DECK_DEF = [["SOLDIER",6],["ANGRY",3],["NINJA",3],["SHIELD",3],
                  ["MINE",2],["FIREBALL",2],["DOCTOR",2],["ARCHER",2]];

/* ---------------- 工具 ---------------- */
const rc = i => ({ r: Math.floor(i / N), c: i % N });
const idx = (r, c) => (r < 0 || c < 0 || r >= N || c >= N) ? -1 : r * N + c;
const spawnRow = pl => pl === 1 ? 0 : N - 1;

/** 有效攻击力：基础攻击 + 怒气加成，受上限约束 */
const effAtk = u => u.rage ? Math.min(u.atk + RAGE_BONUS, RAGE_CAP) : u.atk;

function shuffled() {
  const d = [];
  DECK_DEF.forEach(([t, c]) => { for (let k = 0; k < c; k++) d.push(t); });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}
function neigh(p) {
  const { r, c } = rc(p), out = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    const q = idx(r + dr, c + dc);
    if (q >= 0) out.push(q);
  }
  return out;
}

/* ---------------- 游戏实例 ---------------- */
function newGame() {
  const d1 = shuffled(), d2 = shuffled();
  return {
    units: [], mines: [], log: [], cur: 1, over: null, uid: 1, turn: 1, passes: 0,
    P: {
      1: { hand: d1.slice(0, 7), deck: d1.slice(7), deployed: false, fresh: null, draws: 0 },
      2: { hand: d2.slice(0, 7), deck: d2.slice(7), deployed: false, fresh: null, draws: 0 }
    }
  };
}
const unitAt  = (g, p) => g.units.find(u => u.pos === p);
const minesAt = (g, p) => g.mines.filter(m => m.pos === p);
function log(g, txt, cls) { g.log.push({ txt, cls }); if (g.log.length > 80) g.log.shift(); }

function lineTargets(g, u) {
  const { r, c } = rc(u.pos), out = [];
  [[1,0],[-1,0],[0,1],[0,-1]].forEach(([dr, dc]) => {
    let rr = r + dr, cc = c + dc;
    for (;;) {
      const q = idx(rr, cc);
      if (q < 0) break;
      const t = unitAt(g, q);
      if (t) { if (t.owner !== u.owner) out.push(q); break; }
      rr += dr; cc += dc;
    }
  });
  return out;
}
const moveCells = (g, u) => neigh(u.pos).filter(p => !unitAt(g, p));
function atkCells(g, u) {
  const d = T[u.type];
  if (d.rng === "none") return [];
  if (d.rng === "line") return lineTargets(g, u);
  return neigh(u.pos).filter(p => { const t = unitAt(g, p); return t && t.owner !== u.owner; });
}
function placeCells(g, pl) {
  const r = spawnRow(pl), out = [];
  for (let c = 0; c < N; c++) { const p = idx(r, c); if (!unitAt(g, p)) out.push(p); }
  return out;
}
function fireballCells(g, pl) {
  const rows = pl === 1 ? [N - 1, N - 2] : [0, 1];
  return g.units.filter(u => u.owner !== pl && rows.includes(rc(u.pos).r)).map(u => u.pos);
}

/* ---------------- 战斗 ---------------- */
function damage(g, target, amt, attacker, opt) {
  opt = opt || {};
  const d = T[target.type];

  if (!opt.noDodge && d.sk === "dodge" && Math.random() < 0.5) {
    log(g, `🥷 ${d.n} 闪避了这次攻击！`, "ls");
    return false;
  }

  // 格挡：整局只触发一次；弓箭手无视格挡
  const canBlock = attacker && T[attacker.type].rng !== "line";
  if (canBlock && d.sk === "block" && !target.blockUsed) {
    target.blockUsed = true;
    target.rage = true;
    target.rageTurn = null;          // 下个己方回合生效，用完即消退
    log(g, `😡 ${d.n} 格挡了 ${T[attacker.type].n} 的攻击！怒气爆发：下回合攻击力 ${Math.min(target.atk + RAGE_BONUS, RAGE_CAP)}`, "ls");
    return false;
  }

  let left = amt, ab = 0;
  if (target.shield > 0) { ab = Math.min(target.shield, left); target.shield -= ab; left -= ab; }
  target.hp -= left;
  log(g, `${d.n} 受到 ${amt} 伤害（盾吸 ${ab}，掉血 ${Math.max(0, left)}）`, "l" + target.owner);
  if (target.hp <= 0) { kill(g, target); return true; }
  rescue(g, target);
  return false;
}
function kill(g, u) {
  g.units = g.units.filter(x => x !== u);
  log(g, `💀 玩家${u.owner} 的 ${T[u.type].n} 阵亡`, "l" + u.owner);
  checkOver(g);
}
function rescue(g, u) {
  if (u.hp > 1) return;
  const doc = g.units.find(x => x.owner === u.owner && x.type === "DOCTOR" && neigh(x.pos).includes(u.pos));
  if (!doc) return;
  const r = spawnRow(u.owner);
  for (let c = 0; c < N; c++) {
    const p = idx(r, c);
    if (!unitAt(g, p)) {
      u.pos = p;
      log(g, `⚕️ 医疗兵把残血的 ${T[u.type].n} 拖回出生点`, "l" + u.owner);
      return;
    }
  }
  log(g, `⚕️ 出生行已满，${T[u.type].n} 无法被拖回`, "l" + u.owner);
}
function checkOver(g) {
  [1, 2].forEach(pl => {
    if (g.P[pl].deployed && !g.units.some(u => u.owner === pl)) g.over = pl === 1 ? 2 : 1;
  });
}
function stepMine(g, u) {
  const ms = minesAt(g, u.pos);
  if (!ms.length) return;
  g.mines = g.mines.filter(m => m.pos !== u.pos);
  ms.forEach(() => {
    if (g.units.includes(u)) {
      log(g, `💥 ${T[u.type].n} 踩到了地雷！`, "ls");
      damage(g, u, 10, null, { noDodge: true });
    }
  });
}

/* ---------------- 回合流转 ---------------- */
function endTurn(g) {
  if (g.over) return;
  g.cur = g.cur === 1 ? 2 : 1;
  g.turn++;
  g.P[g.cur].fresh = null;

  // 怒气只持续己方一个回合
  g.units.filter(u => u.owner === g.cur && u.rage).forEach(u => {
    if (u.rageTurn === null) {
      u.rageTurn = g.turn;                      // 本回合可用
    } else if (g.turn > u.rageTurn) {
      u.rage = false; u.rageTurn = null;
      log(g, `😤 ${T[u.type].n} 怒气消退，攻击力回到 ${u.atk}`, "l" + u.owner);
    }
  });

  // 医疗兵自动治疗：同一单位每回合最多回 2 血，无论身边有几个医疗兵
  const healed = new Set();
  g.units.filter(u => u.owner === g.cur && u.type === "DOCTOR").forEach(doc => {
    const cand = g.units
      .filter(x => x.owner === g.cur && x !== doc && x.hp < T[x.type].hp)
      .filter(x => !healed.has(x.uid))          // 本回合已被奶过的跳过
      .filter(x => neigh(doc.pos).includes(x.pos))
      .sort((a, b) => a.hp - b.hp);
    if (cand[0]) {
      const t = cand[0];
      t.hp = Math.min(T[t.type].hp, t.hp + HEAL_PER_TURN);
      healed.add(t.uid);
      log(g, `⚕️ 医疗兵治疗 ${T[t.type].n} +${HEAL_PER_TURN}（现 ${t.hp} 血）`, "l" + g.cur);
    }
  });
}

/* ---------------- 行动校验 ---------------- */
function applyAction(g, pl, a) {
  if (g.over) return "对局已结束";
  if (pl !== g.cur) return "还没轮到你";
  const P = g.P[pl];

  if (a.type === "pass") {
    log(g, `玩家${pl} 跳过回合`, "l" + pl);
    g.passes++;
    if (g.passes >= STALEMATE) {
      g.over = "draw";
      log(g, "双方连续跳过，判定为和局。", "ls");
      return null;
    }
    endTurn(g);
    return null;
  }
  g.passes = 0;

  if (a.type === "draw") {
    if (P.draws >= MAX_DRAWS) return `本局抽牌已用完（上限 ${MAX_DRAWS} 张）`;
    if (!P.deck.length) return "牌堆已空";
    const c = P.deck.shift();
    P.hand.push(c);
    P.draws++;
    log(g, `玩家${pl} 抽了一张牌（还剩 ${MAX_DRAWS - P.draws} 次）`, "l" + pl);
    endTurn(g);
    P.fresh = c;                                // 只有本人看得到抽到什么
    return null;
  }

  if (a.type === "place") {
    if (!P.hand.includes(a.card)) return "你没有这张牌";
    if (T[a.card].spell) return "这不是单位牌";
    if (!placeCells(g, pl).includes(a.pos)) return "只能布置在自己出生行的空格";
    const d = T[a.card];
    const u = { uid: g.uid++, type: a.card, owner: pl, hp: d.hp, shield: d.def,
                atk: d.atk, pos: a.pos, blockUsed: false, rage: false, rageTurn: null };
    g.units.push(u);
    P.hand.splice(P.hand.indexOf(a.card), 1);
    P.deployed = true;
    log(g, `玩家${pl} 布置了 ${d.n}`, "l" + pl);
    stepMine(g, u); checkOver(g); endTurn(g);
    return null;
  }

  if (a.type === "mine") {
    if (!P.hand.includes("MINE")) return "你没有地雷牌";
    if (unitAt(g, a.pos)) return "该格有单位";
    g.mines.push({ pos: a.pos, owner: pl });
    P.hand.splice(P.hand.indexOf("MINE"), 1);
    log(g, `玩家${pl} 埋下了一颗地雷（位置保密）`, "l" + pl);
    endTurn(g);
    return null;
  }

  if (a.type === "fireball") {
    if (!P.hand.includes("FIREBALL")) return "你没有火球牌";
    if (!fireballCells(g, pl).includes(a.pos)) return "火球只能打敌方前两行的单位";
    const t = unitAt(g, a.pos);
    P.hand.splice(P.hand.indexOf("FIREBALL"), 1);
    log(g, `🔥 火球轰向 ${T[t.type].n}！`, "ls");
    const dead = damage(g, t, 10, null);
    if (!dead && g.units.includes(t)) {
      t.atk = Math.max(0, t.atk - 2);
      log(g, `${T[t.type].n} 被烧伤，攻击力降为 ${effAtk(t)}`, "ls");
    }
    checkOver(g); endTurn(g);
    return null;
  }

  const u = g.units.find(x => x.uid === a.uid);
  if (!u || u.owner !== pl) return "那不是你的单位";

  if (a.type === "move") {
    if (!moveCells(g, u).includes(a.pos)) return "不能移动到该格";
    u.pos = a.pos;
    log(g, `玩家${pl} 移动 ${T[u.type].n}`, "l" + pl);
    stepMine(g, u); checkOver(g); endTurn(g);
    return null;
  }

  if (a.type === "attack") {
    if (!atkCells(g, u).includes(a.pos)) return "超出攻击范围";
    const t = unitAt(g, a.pos);
    const dmg = effAtk(u);
    log(g, `⚔️ ${T[u.type].n} 攻击 ${T[t.type].n}（攻击力 ${dmg}${u.rage ? "，怒气中" : ""}）`, "l" + pl);
    damage(g, t, dmg, u);
    checkOver(g); endTurn(g);
    return null;
  }

  return "未知的行动";
}

/* ---------------- 视图删减 ---------------- */
function viewFor(g, pl) {
  const opp = pl === 1 ? 2 : 1;
  return {
    you: pl, cur: g.cur, turn: g.turn, over: g.over,
    units: g.units.map(u => ({
      uid: u.uid, type: u.type, owner: u.owner, pos: u.pos,
      hp: u.hp, shield: u.shield, atk: effAtk(u), rage: !!u.rage
    })),
    mines: g.mines.filter(m => m.owner === pl).map(m => ({ pos: m.pos })),
    hand: g.P[pl].hand.slice(),
    fresh: g.P[pl].fresh,
    deckCount: g.P[pl].deck.length,
    drawsLeft: MAX_DRAWS - g.P[pl].draws,
    oppHandCount: g.P[opp].hand.length,
    oppDeckCount: g.P[opp].deck.length,
    oppDrawsLeft: MAX_DRAWS - g.P[opp].draws,
    log: g.log
  };
}

/* ---------------- 房间 ---------------- */
const rooms = new Map();
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeCode() {
  let c;
  do { c = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join(""); }
  while (rooms.has(c));
  return c;
}
const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
function broadcast(room) {
  [1, 2].forEach(pl => {
    const s = room.sock[pl];
    if (s) send(s, { t: "state", view: viewFor(room.game, pl), code: room.code,
                     bothHere: !!(room.sock[1] && room.sock[2]) });
  });
}

/* ---------------- HTTP + WS ---------------- */
const server = http.createServer((req, res) => {
  const file = (req.url === "/" || req.url.startsWith("/?")) ? "/index.html" : req.url.split("?")[0];
  const fp = path.join(__dirname, "public", path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end("404"); return; }
    const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript",
                   ".css": "text/css" }[path.extname(fp)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
wss.on("connection", ws => {
  ws.room = null; ws.pl = null;
  ws.on("message", raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.t === "create") {
      const code = makeCode();
      const room = { code, game: newGame(), sock: { 1: ws, 2: null } };
      rooms.set(code, room);
      ws.room = room; ws.pl = 1;
      send(ws, { t: "joined", you: 1, code });
      broadcast(room);
    }
    else if (m.t === "join") {
      const room = rooms.get(String(m.code || "").toUpperCase());
      if (!room) return send(ws, { t: "err", msg: "房间不存在" });
      if (room.sock[2] && room.sock[2].readyState === 1) return send(ws, { t: "err", msg: "房间已满" });
      room.sock[2] = ws; ws.room = room; ws.pl = 2;
      send(ws, { t: "joined", you: 2, code: room.code });
      log(room.game, "对手已加入，对局开始！", "ls");
      broadcast(room);
    }
    else if (m.t === "act") {
      const room = ws.room;
      if (!room) return;
      if (!(room.sock[1] && room.sock[2])) return send(ws, { t: "err", msg: "等待对手加入" });
      const err = applyAction(room.game, ws.pl, m.a || {});
      if (err) send(ws, { t: "err", msg: err });
      broadcast(room);
    }
    else if (m.t === "restart") {
      const room = ws.room;
      if (!room) return;
      room.game = newGame();
      log(room.game, `玩家${ws.pl} 发起了新的一局`, "ls");
      broadcast(room);
    }
  });

  ws.on("close", () => {
    const room = ws.room;
    if (!room) return;
    if (room.sock[ws.pl] === ws) room.sock[ws.pl] = null;
    const other = room.sock[ws.pl === 1 ? 2 : 1];
    if (other) send(other, { t: "oppLeft" });
    else rooms.delete(room.code);
  });
});

server.listen(PORT, () => console.log("6x6 战棋服务器已启动: http://localhost:" + PORT));
module.exports = { newGame, applyAction, viewFor, T, effAtk };
