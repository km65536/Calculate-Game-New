"use strict";

/* =========================================================
   Equation Blocks — main.js
   構成:
   1. 状態管理
   2. データ読み込み（data/levels.json, data/*.json）
   3. グリッド／到達可能マス探索（BFS）
   4. 数式判定ロジック
   5. 描画
   6. 操作（選択・移動・アンドゥ）
   7. 画面遷移・初期化
   ========================================================= */

/* ---------------- 1. 状態管理 ---------------- */

const state = {
  levelsMeta: [],      // 各ステージファイルを読んで作った一覧 [{id, name, file, def}, ...]（loadLevelsMeta参照）
  level: null,          // 現在のレベル定義（読み込み直後の生データ）
  width: 0,
  height: 0,
  blocks: {},           // id -> block（現在の可変状態。x, y が動く）
  grid: [],             // grid[y][x] = blockId | null
  edges: { v: [], h: [] }, // 壁・一方通行（マスとマスの間の辺）。レベル中は不変。
  selectedId: null,
  reachable: new Map(), // "x,y" -> {x,y}（現在ハイライト中のマス）
  history: [],          // {blockId, from:{x,y}, to:{x,y}, path:[{x,y}...]}
  animating: false,
  cleared: new Set(),   // クリア済みレベルid（localStorageで復元）
};

const STORAGE_KEY = "equation-blocks-cleared";

function loadClearedFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) JSON.parse(raw).forEach((id) => state.cleared.add(id));
  } catch (e) {
    /* localStorageが使えない環境ではメモリ上だけで管理 */
  }
}

function saveClearedToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...state.cleared]));
  } catch (e) {
    /* 保存できなくてもゲームは続行可能 */
  }
}

/* ---------------- 2. データ読み込み ---------------- */

async function fetchJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`failed to load ${path}: ${res.status}`);
  return res.json();
}

// levels.json は各ステージのファイルパスの一覧だけを持つ。
// id・nameはステージ自身のファイル（data/levelN.json）に既に書いてあるので、
// levels.json 側には重複して持たせない（片方だけ直して同期が崩れる事故を防ぐため）。
async function loadLevelsMeta() {
  const data = await fetchJSON("data/levels.json");
  const files = data.levels;
  state.levelsMeta = await Promise.all(
    files.map(async (file) => {
      const def = await fetchJSON(file);
      // ついでにレベル本体もキャッシュしておき、実際に開く時の二重fetchを避ける
      return { id: def.id, name: def.name, file, def };
    })
  );
}

async function loadLevel(meta) {
  // loadLevelsMetaの時点でキャッシュ済みならそれを使う（二重fetchを避ける）
  const def = meta.def || (await fetchJSON(meta.file));
  const level = levelFromGridDef(def);
  state.level = level;
  state.width = level.width;
  state.height = level.height;
  state.blocks = {};
  for (const b of level.blocks) {
    state.blocks[b.id] = { ...b };
  }
  state.grid = buildGrid();
  state.edges = level.edges;
  state.selectedId = null;
  state.reachable = new Map();
  state.history = [];
}

/* ---------- 2次元配列(grid)形式のレベル定義パーサー ----------
   マップは data/level*.json 内の "grid" プロパティに、
   行(y) × 列(x) の2次元配列として書く。1マス1トークン。
   盤面の外に出ることはそもそもできないので、周囲を壁で囲む必要はない。

   セルのトークン（マスの中身）:
     "."  空きマス
     "3"  数字ブロック（動かせる。0〜9）
     "3!" 数字ブロック（動かせない。末尾の "!" が「固定」の意味）
     "+" "-" "*" "/" "(" ")"   記号ブロック（動かせる）
       ※ *=× (かける)、/=÷ (わる) のエイリアスとして使える（ファイル上の書きやすさのため。
         盤面の見た目では文字ブロックの"x"とは別物として表示されるので混同しない）
     "+!" のように末尾に "!" を付けると固定（動かせない）記号ブロックになる
     "="  横向きの＝（動かせる）　　"=!" 横向きの＝（固定）
     "|"  縦向きの＝(‖) （動かせる）　"|!" 縦向きの＝（固定）
     ":=" 代入の記号（動かせる）　　":=!" 代入の記号（固定）
     "a" "b" "c" "d" "x" "y" "z" "f" "g" "h"
          文字ブロック＝変数（動かせる。それぞれの文字自体に意味はない）
          "x!" のように末尾に "!" を付けると固定になる（他の文字ブロックと同様）
          数字ブロックと違って、文字ブロック同士は隣接しても連結しない
          （常に1マス＝1文字として扱われる）

   壁・一方通行は「マス」ではなく「マスとマスの間の辺」に置く。
   "walls" プロパティに以下の2つの2次元配列を書く（省略した場合は全て開いた状態＝壁なし）:
     "v": 縦の辺（左右に隣り合うマスの境界）。行数=height、各行の要素数=width-1。
          v[y][x] は マス(x,y) と マス(x+1,y) の間の辺。
          "." 開いている　"#" 壁（両方向とも通れない）
          ">" 右向きの一方通行（右へは通れるが左へは通れない）
          "<" 左向きの一方通行
     "h": 横の辺（上下に隣り合うマスの境界）。行数=height-1、各行の要素数=width。
          h[y][x] は マス(x,y) と マス(x,y+1) の間の辺。
          "." 開いている　"#" 壁
          "v" 下向きの一方通行（下へは通れるが上へは通れない）
          "^" 上向きの一方通行

   例（1+2=3 を作るステージ。周囲の壁は不要になった）:
     {
       "grid": [
         ["3",".","1",".","2"],
         [".","+!",".","=!","."],
         [".",".",".",".","."]
       ]
     }
*/

const SYMBOL_TOKEN_ALIASES = {
  "+": "+",
  "-": "-",
  "*": "×",
  "×": "×",
  "/": "÷",
  "÷": "÷",
  "(": "(",
  ")": ")",
};

// 文字ブロック（変数）として使える文字。それぞれに特定の意味はなく、区別できる文字であればよい。
const LETTER_SET = new Set(["a", "b", "c", "d", "x", "y", "z", "f", "g", "h"]);

function parseCellToken(rawToken, x, y) {
  const token = rawToken == null ? "." : String(rawToken).trim();
  if (token === "." || token === "") return null;

  let core = token;
  let fixed = false;
  if (core.endsWith("!")) {
    fixed = true;
    core = core.slice(0, -1);
  }

  if (/^[0-9]$/.test(core)) {
    return { type: "number", value: parseInt(core, 10), movable: !fixed, x, y };
  }
  if (core === "=") {
    return { type: "symbol", value: "=", orientation: "horizontal", movable: !fixed, x, y };
  }
  if (core === "|" || core === "‖") {
    return { type: "symbol", value: "=", orientation: "vertical", movable: !fixed, x, y };
  }
  if (core === ":=") {
    return { type: "symbol", value: ":=", movable: !fixed, x, y };
  }
  if (LETTER_SET.has(core)) {
    return { type: "letter", value: core, movable: !fixed, x, y };
  }
  if (SYMBOL_TOKEN_ALIASES[core]) {
    return { type: "symbol", value: SYMBOL_TOKEN_ALIASES[core], movable: !fixed, x, y };
  }
  console.warn(`[level "${x},${y}"] unknown token "${rawToken}" — このマスは空きマス扱いにします`);
  return null;
}

// 辺のトークンを正規化する。不正な値は「開いている」扱いにする。
function normalizeEdgeToken(t) {
  if (t == null || t === "") return ".";
  const s = String(t).trim();
  if (s === "V") return "v";
  if (s === "." || s === "#" || s === ">" || s === "<" || s === "^" || s === "v") return s;
  return ".";
}

function buildEdgesFromDef(wallsDef, width, height) {
  const vSrc = (wallsDef && wallsDef.v) || [];
  const hSrc = (wallsDef && wallsDef.h) || [];
  const v = Array.from({ length: height }, (_, y) => {
    const row = vSrc[y] || [];
    return Array.from({ length: Math.max(0, width - 1) }, (_, x) => normalizeEdgeToken(row[x]));
  });
  const h = Array.from({ length: Math.max(0, height - 1) }, (_, y) => {
    const row = hSrc[y] || [];
    return Array.from({ length: width }, (_, x) => normalizeEdgeToken(row[x]));
  });
  return { v, h };
}

function levelFromGridDef(def) {
  const gridDef = def.grid;
  const height = gridDef.length;
  const width = gridDef.reduce((max, row) => Math.max(max, row.length), 0);
  const blocks = [];
  let counter = 0;
  for (let y = 0; y < height; y++) {
    const row = gridDef[y] || [];
    for (let x = 0; x < width; x++) {
      const block = parseCellToken(row[x], x, y);
      if (block) {
        block.id = `b${++counter}`;
        blocks.push(block);
      }
    }
  }
  const edges = buildEdgesFromDef(def.walls, width, height);
  return { id: def.id, name: def.name, hint: def.hint, width, height, blocks, edges };
}

/* ---------------- 3. グリッド／到達可能マス探索 ---------------- */

function buildGrid() {
  const grid = Array.from({ length: state.height }, () => new Array(state.width).fill(null));
  for (const b of Object.values(state.blocks)) grid[b.y][b.x] = b.id;
  return grid;
}

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

// (cx,cy) から (dx,dy) 方向へ進んで (nx,ny) に入れるかどうかを判定する。
// 1. まず (cx,cy)-(nx,ny) の間の「辺」を見る。壁ならどちら向きにも通れない。
//    一方通行なら、矢印と進行方向が逆なら通れない。
// 2. 辺が開いていても、(nx,ny) 自体に数字・記号ブロックが乗っていれば通れない。
function isPassable(cx, cy, nx, ny, dx, dy) {
  if (dx === 1) {
    const t = state.edges.v[cy] && state.edges.v[cy][cx];
    if (t === "#" || t === "<") return false;
  } else if (dx === -1) {
    const t = state.edges.v[cy] && state.edges.v[cy][nx];
    if (t === "#" || t === ">") return false;
  } else if (dy === 1) {
    const t = state.edges.h[cy] && state.edges.h[cy][cx];
    if (t === "#" || t === "^") return false;
  } else if (dy === -1) {
    const t = state.edges.h[ny] && state.edges.h[ny][cx];
    if (t === "#" || t === "v") return false;
  }
  return state.grid[ny][nx] === null;
}

// 指定ブロックが「曲がりながら」到達できる空きマスを幅優先探索で全て求める。
// 経路上のどのマスも、他ブロック（動かせる／動かせない問わず）で塞がれていたら通れない。
// 壁や一方通行は「マスとマスの間の辺」にあり、isPassableでその通行可否を判定する。
function computeReachable(startX, startY) {
  const visited = new Map(); // "x,y" -> parentKey
  const startKey = `${startX},${startY}`;
  visited.set(startKey, null);
  const queue = [[startX, startY]];
  while (queue.length) {
    const [cx, cy] = queue.shift();
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= state.width || ny >= state.height) continue;
      const key = `${nx},${ny}`;
      if (visited.has(key)) continue;
      if (!isPassable(cx, cy, nx, ny, dx, dy)) continue;
      visited.set(key, `${cx},${cy}`);
      queue.push([nx, ny]);
    }
  }
  visited.delete(startKey);
  return visited; // key -> parentKey
}

function reconstructPath(parentMap, targetX, targetY) {
  const path = [];
  let key = `${targetX},${targetY}`;
  // 開始地点は computeReachable 内で visited から削除済みのため、
  // parentMap.get() が undefined を返した時点でも終端とみなす（null/undefined どちらも終了条件）。
  while (key != null) {
    const [x, y] = key.split(",").map(Number);
    path.push({ x, y });
    key = parentMap.has(key) ? parentMap.get(key) : null;
  }
  path.reverse(); // start -> ... -> target
  path.shift(); // start地点は除く
  return path;
}

/* ---------------- 4. 数式判定ロジック ---------------- */

const OP_MAP = { "+": "+", "-": "-", "×": "*", "÷": "/" };

// 縦の辺(x,y)-(x+1,y)が壁かどうか
function edgeVIsWall(x, y) {
  return !!(state.edges.v[y] && state.edges.v[y][x] === "#");
}
// 横の辺(x,y)-(x,y+1)が壁かどうか
function edgeHIsWall(x, y) {
  return !!(state.edges.h[y] && state.edges.h[y][x] === "#");
}

function getRuns() {
  const runs = [];
  for (let y = 0; y < state.height; y++) {
    let run = [];
    for (let x = 0; x < state.width; x++) {
      const id = state.grid[y][x];
      const b = id ? state.blocks[id] : null;
      const wallBefore = x > 0 && edgeVIsWall(x - 1, y);
      if (!b || wallBefore) {
        if (run.length) runs.push({ dir: "h", blocks: run });
        run = [];
      }
      if (b) run.push(b);
    }
    if (run.length) runs.push({ dir: "h", blocks: run });
  }
  for (let x = 0; x < state.width; x++) {
    let run = [];
    for (let y = 0; y < state.height; y++) {
      const id = state.grid[y][x];
      const b = id ? state.blocks[id] : null;
      const wallBefore = y > 0 && edgeHIsWall(x, y - 1);
      if (!b || wallBefore) {
        if (run.length) runs.push({ dir: "v", blocks: run });
        run = [];
      }
      if (b) run.push(b);
    }
    if (run.length) runs.push({ dir: "v", blocks: run });
  }
  return runs;
}

function runHasOrientedEquals(run) {
  const wantOrientation = run.dir === "h" ? "horizontal" : "vertical";
  return run.blocks.some(
    (b) => b.type === "symbol" && b.value === "=" && (b.orientation || "horizontal") === wantOrientation
  );
}

// runが「:=（代入）」を含むかどうか
function runHasAssignment(run) {
  return run.blocks.some((b) => b.type === "symbol" && b.value === ":=");
}

function tokenizeRun(run) {
  const tokens = [];
  let numBuf = "";
  const flushNum = () => {
    if (numBuf !== "") {
      tokens.push({ t: "num", v: parseInt(numBuf, 10) });
      numBuf = "";
    }
  };
  for (const b of run.blocks) {
    if (b.type === "number") {
      numBuf += String(b.value);
    } else if (b.type === "letter") {
      // 数字と違い、文字ブロックは隣接していても連結しない。常に1マス=1変数。
      flushNum();
      tokens.push({ t: "var", name: b.value });
    } else {
      flushNum();
      if (b.value === "=") tokens.push({ t: "eq" });
      else if (b.value === ":=") tokens.push({ t: "assign" });
      else if (b.value === "(") tokens.push({ t: "lparen" });
      else if (b.value === ")") tokens.push({ t: "rparen" });
      else tokens.push({ t: "op", v: OP_MAP[b.value] });
    }
  }
  flushNum();
  return tokens;
}

// varValues: { 変数名: 数値 } 。funcs: { 関数名: {paramName, rhs(トークン列)} } 。
// どちらも省略した場合は、変数・関数を一切解決できないものとして評価する。
function evalExpr(tokens, varValues, funcs) {
  const vars = varValues || {};
  const fns = funcs || {};
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseExpr() {
    let v = parseTerm();
    while (peek() && peek().t === "op" && (peek().v === "+" || peek().v === "-")) {
      const op = next().v;
      const rhs = parseTerm();
      v = op === "+" ? v + rhs : v - rhs;
    }
    return v;
  }
  function parseTerm() {
    let v = parseFactor();
    while (peek() && peek().t === "op" && (peek().v === "*" || peek().v === "/")) {
      const op = next().v;
      const rhs = parseFactor();
      if (op === "/") {
        if (rhs === 0) throw new Error("div0");
        v = v / rhs;
      } else {
        v = v * rhs;
      }
    }
    return v;
  }
  function parseFactor() {
    const tk = peek();
    if (!tk) throw new Error("unexpected end");
    if (tk.t === "num") {
      next();
      return tk.v;
    }
    if (tk.t === "var") {
      next();
      // 文字の直後に "(" が続く場合は、変数参照ではなく「関数呼び出し」として扱う
      if (peek() && peek().t === "lparen") {
        next(); // '(' を消費
        const argValue = parseExpr();
        const c = next();
        if (!c || c.t !== "rparen") throw new Error("expected ) after function argument");
        const fn = fns[tk.name];
        if (!fn) throw new Error(`unresolved function ${tk.name}`);
        return evalExpr(fn.rhs, { ...vars, [fn.paramName]: argValue }, fns);
      }
      if (!Object.prototype.hasOwnProperty.call(vars, tk.name)) {
        throw new Error(`unresolved variable ${tk.name}`);
      }
      return vars[tk.name];
    }
    if (tk.t === "lparen") {
      next();
      const v = parseExpr();
      const c = next();
      if (!c || c.t !== "rparen") throw new Error("expected )");
      return v;
    }
    throw new Error("unexpected token");
  }

  if (!tokens.length) throw new Error("empty");
  const result = parseExpr();
  if (pos !== tokens.length) throw new Error("trailing tokens");
  return result;
}

function checkRun(run, varValues, funcs) {
  const tokens = tokenizeRun(run);
  const segments = [[]];
  for (const tk of tokens) {
    if (tk.t === "eq") segments.push([]);
    else segments[segments.length - 1].push(tk);
  }
  if (segments.length < 2) return false;
  try {
    const values = segments.map((seg) => evalExpr(seg, varValues, funcs));
    const eps = 1e-9;
    for (let i = 1; i < values.length; i++) {
      if (Math.abs(values[i] - values[0]) > eps) return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

// runが「代入 or 関数定義として成立する形」かどうかを判定する。
//   変数代入: [変数] := [右辺の式]                          例: x := 5
//   関数定義: [関数名] ( [入力変数] ) := [右辺の式]           例: f(x) := x+2
// どちらの形にも当てはまらなければ null を返す（右辺に=や:=が混ざる場合も不正として null）。
function classifyAssignmentShape(run) {
  const tokens = tokenizeRun(run);

  // 関数定義の形： var lparen var rparen assign ...rhs
  if (
    tokens.length >= 6 &&
    tokens[0].t === "var" &&
    tokens[1].t === "lparen" &&
    tokens[2].t === "var" &&
    tokens[3].t === "rparen" &&
    tokens[4].t === "assign"
  ) {
    const rhs = tokens.slice(5);
    if (rhs.length > 0 && !rhs.some((t) => t.t === "assign" || t.t === "eq")) {
      return { kind: "function", funcName: tokens[0].name, paramName: tokens[2].name, rhs };
    }
    return null;
  }

  // 変数代入の形： var assign ...rhs
  if (tokens.length >= 2 && tokens[0].t === "var" && tokens[1].t === "assign") {
    const rhs = tokens.slice(2);
    if (rhs.length > 0 && !rhs.some((t) => t.t === "assign" || t.t === "eq")) {
      return { kind: "variable", varName: tokens[0].name, rhs };
    }
    return null;
  }

  return null;
}

// 後方互換用（variable_test.js等の既存テストが直接参照している）
function assignmentShape(run) {
  const shape = classifyAssignmentShape(run);
  return shape && shape.kind === "variable" ? { varName: shape.varName, rhs: shape.rhs } : null;
}

// 盤面上の全ての代入（:=）候補を集め、固定点反復で変数の値を確定させる。
// 例: x:=1, y:=x+1 のような依存関係も、収束するまで繰り返し評価することで解決する。
function resolveVariables() {
  const assignRuns = getRuns().filter(runHasAssignment);
  const varCandidates = [];
  const funcCandidates = [];
  for (const run of assignRuns) {
    const shape = classifyAssignmentShape(run);
    if (!shape) continue;
    if (shape.kind === "function") funcCandidates.push({ run, shape });
    else varCandidates.push({ run, shape });
  }

  // 同じ名前に対する代入・定義が2つ以上あれば「失敗している」とみなし、値の確定には使わない。
  const nameCounts = new Map();
  for (const c of varCandidates) nameCounts.set(c.shape.varName, (nameCounts.get(c.shape.varName) || 0) + 1);
  const conflictedNames = new Set([...nameCounts.entries()].filter(([, n]) => n > 1).map(([name]) => name));

  const funcNameCounts = new Map();
  for (const c of funcCandidates) funcNameCounts.set(c.shape.funcName, (funcNameCounts.get(c.shape.funcName) || 0) + 1);
  const conflictedFuncNames = new Set([...funcNameCounts.entries()].filter(([, n]) => n > 1).map(([name]) => name));

  const varValues = {};
  const funcs = {}; // 関数名 -> { paramName, rhs(トークン列) }

  // 変数と関数は互いに参照し合えるので（関数の中で他の変数・関数を使う、変数の右辺で関数を呼ぶ等）、
  // 両方をまとめて固定点反復で解決する。
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of varCandidates) {
      if (conflictedNames.has(c.shape.varName)) continue;
      if (Object.prototype.hasOwnProperty.call(varValues, c.shape.varName)) continue;
      try {
        varValues[c.shape.varName] = evalExpr(c.shape.rhs, varValues, funcs);
        changed = true;
      } catch (e) {
        // まだ解決できない。次の周回で再挑戦する。
      }
    }
    for (const c of funcCandidates) {
      if (conflictedFuncNames.has(c.shape.funcName)) continue;
      if (Object.prototype.hasOwnProperty.call(funcs, c.shape.funcName)) continue;
      // 入力変数は「未定義」である必要がある（すでに他の場所で変数として値が決まっていてはいけない）
      if (Object.prototype.hasOwnProperty.call(varValues, c.shape.paramName)) continue;
      try {
        // 右辺が構造的に評価できるか、入力変数にダミー値(1)を入れて検証する。
        // 実際の計算結果はここでは使わない（関数は呼び出し時に毎回、実際の引数で評価し直す）。
        evalExpr(c.shape.rhs, { ...varValues, [c.shape.paramName]: 1 }, funcs);
        funcs[c.shape.funcName] = { paramName: c.shape.paramName, rhs: c.shape.rhs };
        changed = true;
      } catch (e) {
        // まだ解決できない。次の周回で再挑戦する。
      }
    }
  }

  const satisfiedVarRunIds = new Set();
  for (const c of varCandidates) {
    if (conflictedNames.has(c.shape.varName)) continue;
    if (Object.prototype.hasOwnProperty.call(varValues, c.shape.varName)) satisfiedVarRunIds.add(c.run);
  }
  const satisfiedFuncRunIds = new Set();
  for (const c of funcCandidates) {
    if (conflictedFuncNames.has(c.shape.funcName)) continue;
    if (Object.prototype.hasOwnProperty.call(funcs, c.shape.funcName)) satisfiedFuncRunIds.add(c.run);
  }

  return {
    varValues,
    funcs,
    varCandidates,
    funcCandidates,
    satisfiedVarRunIds,
    satisfiedFuncRunIds,
    nameCounts,
    funcNameCounts,
    // 後方互換（既存テストや呼び出し元向け）
    candidates: varCandidates,
    satisfiedRunIds: satisfiedVarRunIds,
  };
}

function checkWin() {
  const { varValues, funcs } = resolveVariables();
  const runs = getRuns();
  const checked = runs.filter(runHasOrientedEquals);
  if (checked.length === 0) return false;
  return checked.every((r) => checkRun(r, varValues, funcs) === true);
}

// 現在成立している等式（run）だけを抜き出す。ハイライト表示に使う。
function getSatisfiedRuns() {
  const { varValues, funcs } = resolveVariables();
  return getRuns().filter((r) => runHasOrientedEquals(r) && checkRun(r, varValues, funcs) === true);
}

// 現在成立している代入・関数定義（run）だけを抜き出す。ハイライト表示（紫の枠）に使う。
function getSatisfiedAssignmentRuns() {
  const { varCandidates, satisfiedVarRunIds, funcCandidates, satisfiedFuncRunIds } = resolveVariables();
  const varRuns = varCandidates.filter((c) => satisfiedVarRunIds.has(c.run)).map((c) => c.run);
  const funcRuns = funcCandidates.filter((c) => satisfiedFuncRunIds.has(c.run)).map((c) => c.run);
  return [...varRuns, ...funcRuns];
}

// 「代入・関数定義として完成しているのに成立していない」runを全部抜き出す（×印の表示に使う）。
// 同じ名前への重複だけでなく、右辺に未解決の変数・関数がある場合、
// 関数の入力変数がすでに変数として使われている場合なども、ここに含まれる。
function getFailedAssignmentRuns() {
  const { varCandidates, satisfiedVarRunIds, funcCandidates, satisfiedFuncRunIds } = resolveVariables();
  const varRuns = varCandidates.filter((c) => !satisfiedVarRunIds.has(c.run)).map((c) => c.run);
  const funcRuns = funcCandidates.filter((c) => !satisfiedFuncRunIds.has(c.run)).map((c) => c.run);
  return [...varRuns, ...funcRuns];
}

// runの中で使われている var トークンを、「関数呼び出しの一部（直後に(が続く）」か
// 「普通の変数参照」かに分けて、未解決なものを抜き出す。boundName は関数定義の入力変数など、
// このrunの中では束縛済みとして扱ってよい名前（無ければ null）。
function findUnresolvedRefs(tokens, varValues, funcs, boundName) {
  const missingVars = new Set();
  const missingFuncs = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.t !== "var") continue;
    const isCall = tokens[i + 1] && tokens[i + 1].t === "lparen";
    if (isCall) {
      if (!Object.prototype.hasOwnProperty.call(funcs, t.name)) missingFuncs.add(t.name);
    } else {
      if (t.name === boundName) continue;
      if (!Object.prototype.hasOwnProperty.call(varValues, t.name)) missingVars.add(t.name);
    }
  }
  return { missingVars: [...missingVars], missingFuncs: [...missingFuncs] };
}

// 文字ブロック（変数）1つについて、今の状態を説明する情報を返す。
// { defined:true, value } か、{ defined:false, reason } のどちらか。
// ツールチップ（ホバー表示）で使う。
function explainVariableStatus(name) {
  const { varValues, funcs, candidates, nameCounts } = resolveVariables();
  if (Object.prototype.hasOwnProperty.call(varValues, name)) {
    return { defined: true, value: varValues[name] };
  }
  const count = nameCounts.get(name) || 0;
  if (count === 0) {
    return { defined: false, reason: "代入されていません" };
  }
  if (count > 1) {
    return { defined: false, reason: `この文字への代入が${count}個あります（1つにしてください）` };
  }
  const cand = candidates.find((c) => c.shape.varName === name);
  if (!cand) return { defined: false, reason: "右辺の式が計算できません" };
  const { missingVars, missingFuncs } = findUnresolvedRefs(cand.shape.rhs, varValues, funcs, null);
  if (missingVars.length > 0) {
    return { defined: false, reason: `右辺の「${missingVars.join("」「")}」が未解決です` };
  }
  if (missingFuncs.length > 0) {
    return { defined: false, reason: `右辺の関数「${missingFuncs.join("」「")}」が未定義です` };
  }
  return { defined: false, reason: "右辺の式が計算できません" };
}

// 失敗している代入・関数定義(run)そのものについて、「なぜ成立していないか」を説明する文を返す。
// explainVariableStatusと似ているが、こちらは変数名ではなく式(run)そのものに紐づく。
function explainFailureForCandidate(cand, varValues, funcs, nameCounts, funcNameCounts) {
  if (cand.shape.kind === "function") {
    const name = cand.shape.funcName;
    const count = funcNameCounts.get(name) || 0;
    if (count > 1) {
      return `関数「${name}」の定義が${count}個あります（1つにしてください）`;
    }
    if (Object.prototype.hasOwnProperty.call(varValues, cand.shape.paramName)) {
      return `入力変数「${cand.shape.paramName}」はすでに変数として使われています（別の文字にしてください）`;
    }
    const { missingVars, missingFuncs } = findUnresolvedRefs(cand.shape.rhs, varValues, funcs, cand.shape.paramName);
    if (missingVars.length > 0) {
      return `右辺の「${missingVars.join("」「")}」が未解決です`;
    }
    if (missingFuncs.length > 0) {
      return `右辺の関数「${missingFuncs.join("」「")}」が未定義です`;
    }
    return "右辺の式が計算できません";
  }

  const name = cand.shape.varName;
  const count = nameCounts.get(name) || 0;
  if (count > 1) {
    return `「${name}」への代入が${count}個あります（1つにしてください）`;
  }
  const { missingVars, missingFuncs } = findUnresolvedRefs(cand.shape.rhs, varValues, funcs, null);
  if (missingVars.length > 0) {
    return `右辺の「${missingVars.join("」「")}」が未解決です`;
  }
  if (missingFuncs.length > 0) {
    return `右辺の関数「${missingFuncs.join("」「")}」が未定義です`;
  }
  return "右辺の式が計算できません";
}

function explainAssignmentFailure(run) {
  const { varValues, funcs, varCandidates, funcCandidates, nameCounts, funcNameCounts } = resolveVariables();
  const cand = [...varCandidates, ...funcCandidates].find((c) => c.run === run);
  if (!cand) return "この式はまだ成立していません";
  return explainFailureForCandidate(cand, varValues, funcs, nameCounts, funcNameCounts);
}

/* ---------------- 5. 描画 ---------------- */

const els = {};
function cacheEls() {
  els.header = document.getElementById("game-header-actions");
  els.screenSelect = document.getElementById("screen-select");
  els.screenGame = document.getElementById("screen-game");
  els.levelList = document.getElementById("level-list");
  els.levelProgress = document.getElementById("level-progress");
  els.levelName = document.getElementById("current-level-name");
  els.levelHint = document.getElementById("level-hint");
  els.boardWrap = document.getElementById("board-wrap");
  els.board = document.getElementById("board");
  els.clearOverlay = document.getElementById("clear-overlay");
  els.clearPreview = document.getElementById("clear-preview");
  els.btnBack = document.getElementById("btn-back");
  els.btnUndo = document.getElementById("btn-undo");
  els.btnReset = document.getElementById("btn-reset");
  els.btnNext = document.getElementById("btn-next");
  els.btnReplay = document.getElementById("btn-replay");
  els.btnClearToSelect = document.getElementById("btn-clear-to-select");
}

function symbolGlyph(value) {
  if (value === ":=") return "\u{2254}"; // ≔ (COLON EQUALS)。内部データ上は":="のまま、見た目だけこの1文字にする
  return value; // '+','-','×','÷','(',')','='
}

// 文字ブロック（変数）は、CSSの疑似イタリックではなく、Unicodeの数学用イタリック文字
// （Mathematical Alphanumeric Symbols）を使って表示する。グリフ自体が斜体としてデザイン
// されているので、フォント側でitalicをかける必要はない。
// 小文字hだけこのブロックに正式な文字が無く、代わりにℎ（U+210E, プランク定数記号）を使う。
const LETTER_ITALIC_GLYPH = {
  a: "\u{1D44E}", // 𝑎
  b: "\u{1D44F}", // 𝑏
  c: "\u{1D450}", // 𝑐
  d: "\u{1D451}", // 𝑑
  x: "\u{1D465}", // 𝑥
  y: "\u{1D466}", // 𝑦
  z: "\u{1D467}", // 𝑧
  f: "\u{1D453}", // 𝑓
  g: "\u{1D454}", // 𝑔
  h: "\u{210E}", // ℎ
};
function letterGlyph(value) {
  return LETTER_ITALIC_GLYPH[value] || value;
}

function updateCellSize() {
  const wrapWidth = els.boardWrap.clientWidth || window.innerWidth || 640;
  const availableWidth = Math.max(160, wrapWidth - 4);

  const viewportHeight = window.innerHeight || 800;
  const boardTop = els.boardWrap.getBoundingClientRect ? els.boardWrap.getBoundingClientRect().top : 160;
  // ヘッダーやヒント、下の説明文などの分を大まかに差し引いて、
  // 盤面が縦にもはみ出さない高さを確保する
  const reservedBelow = 90;
  const availableHeight = Math.max(160, viewportHeight - boardTop - reservedBelow);

  const sizeByWidth = Math.floor(availableWidth / state.width);
  const sizeByHeight = Math.floor(availableHeight / state.height);
  const size = Math.max(24, Math.min(84, sizeByWidth, sizeByHeight));

  document.documentElement.style.setProperty("--cell-size", `${size}px`);
}

function cellPx(n) {
  return `calc(var(--cell-size) * ${n})`;
}

function renderLevelSelect() {
  els.levelList.innerHTML = "";
  const clearedCount = state.levelsMeta.filter((m) => state.cleared.has(m.id)).length;
  if (els.levelProgress) {
    const total = state.levelsMeta.length;
    els.levelProgress.textContent = total ? `クリア状況：${clearedCount} / ${total}` : "";
  }
  state.levelsMeta.forEach((meta, idx) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "level-row";
    const cleared = state.cleared.has(meta.id);
    if (cleared) row.classList.add("is-cleared");
    row.innerHTML = `
      <span class="stage-num">${idx + 1}</span>
      <span class="name">${escapeHTML(meta.name)}</span>
      <span class="status">${cleared ? "✓ CLEAR" : ""}</span>
    `;
    row.addEventListener("click", () => openLevel(meta));
    els.levelList.appendChild(row);
  });
}

function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function renderBoard() {
  updateCellSize();
  els.board.innerHTML = "";
  els.board.style.width = cellPx(state.width);
  els.board.style.height = cellPx(state.height);

  for (const block of Object.values(state.blocks)) {
    els.board.appendChild(renderBlockEl(block));
  }
  renderEdges();
}

// 壁・一方通行は「マスとマスの間の辺」に描画する。レベル読み込み時（＝盤面構造が変わる時）だけ呼べば良い。
// container を渡せば、盤面プレビュー（クリア画面のミニチュア表示）にも同じロジックを使い回せる。
//
// 画像素材は「縦向き」を1枚だけ持ち、横向きはCSSのtransform:rotate(90deg)で作る。
// rotateは要素の中心を軸に回るので、回す前の（縦向きのままの）位置を
// 「最終的に見せたい横向きの中心」に合わせて配置してから回転させる。
function renderEdges(container) {
  const target = container || els.board;
  // 縦の辺（左右に隣り合うマスの境界）
  for (let y = 0; y < state.height; y++) {
    for (let x = 0; x < state.width - 1; x++) {
      const t = state.edges.v[y][x];
      if (t === ".") continue;
      if (t === "#") {
        const el = document.createElement("div");
        el.className = "edge-wall";
        el.style.left = `calc(${cellPx(x + 1)} - 3px)`;
        el.style.top = cellPx(y);
        target.appendChild(el);
      } else {
        const dirClass = t === ">" ? "dir-right" : "dir-left";
        const bar = document.createElement("div");
        bar.className = `edge-oneway-bar ${dirClass}`;
        bar.style.left = `calc(${cellPx(x + 1)} - 6px)`;
        bar.style.top = cellPx(y);
        target.appendChild(bar);
      }
    }
  }
  // 横の辺（上下に隣り合うマスの境界）：画像は縦向きのまま、中心位置を合わせて90度回す
  for (let y = 0; y < state.height - 1; y++) {
    for (let x = 0; x < state.width; x++) {
      const t = state.edges.h[y][x];
      if (t === ".") continue;
      if (t === "#") {
        const el = document.createElement("div");
        el.className = "edge-wall edge-wall-h";
        el.style.left = `calc(${cellPx(x)} + var(--cell-size) * 0.5 - 3px)`;
        el.style.top = `calc(${cellPx(y + 1)} - var(--cell-size) * 0.5)`;
        target.appendChild(el);
      } else {
        const dirClass = t === "v" ? "dir-down" : "dir-up";
        const bar = document.createElement("div");
        bar.className = `edge-oneway-bar ${dirClass}`;
        bar.style.left = `calc(${cellPx(x)} + var(--cell-size) * 0.5 - 6px)`;
        bar.style.top = `calc(${cellPx(y + 1)} - var(--cell-size) * 0.5)`;
        target.appendChild(bar);
      }
    }
  }
}

function renderBlockEl(block) {
  const el = document.createElement("div");
  el.id = `block-${block.id}`;
  el.style.left = cellPx(block.x);
  el.style.top = cellPx(block.y);
  el.style.width = "var(--cell-size)";
  el.style.height = "var(--cell-size)";

  const kind =
    block.type === "number" ? "block-number" : block.type === "letter" ? "block-letter" : "block-symbol";
  el.className = `block ${kind} ${block.movable ? "movable" : "fixed"}`;

  const glyph = document.createElement("span");
  glyph.className = "symbol-glyph";
  if (block.type === "number") {
    glyph.textContent = String(block.value);
  } else if (block.type === "letter") {
    glyph.textContent = letterGlyph(block.value);
  } else {
    glyph.textContent = symbolGlyph(block.value);
    if (block.value === "=" && block.orientation === "vertical") {
      glyph.classList.add("rotate");
    }
  }
  el.appendChild(glyph);

  if (block.id === state.selectedId) el.classList.add("selected");

  if (block.movable) {
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (block.type === "letter" && suppressNextLetterClick) {
        suppressNextLetterClick = false;
        return;
      }
      onBlockClick(block.id);
    });
  }

  if (block.type === "letter") {
    attachVarTooltipHandlers(block, el);
  }

  return el;
}

/* ---- 文字ブロックの役割判定：変数参照／関数定義の名前／関数呼び出しの名前 ---- */

// tokens内で、numberブロックの連結を考慮しつつ、targetBlockに対応するトークンの
// インデックスを返す（targetBlockは必ずletter/symbolブロックである前提）。
function tokenIndexOfBlock(runBlocks, targetBlock) {
  let idx = 0;
  let inNumberRun = false;
  for (const b of runBlocks) {
    if (b.type === "number") {
      inNumberRun = true;
      continue;
    }
    if (inNumberRun) {
      idx++;
      inNumberRun = false;
    }
    if (b === targetBlock) return idx;
    idx++;
  }
  return -1;
}

// 対応する閉じ括弧のトークンインデックスを返す（openIdxは開き括弧自身の位置）
function matchingRParenIndex(tokens, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    if (tokens[i].t === "lparen") depth++;
    else if (tokens[i].t === "rparen") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// 文字ブロック1つについて、盤面上での「役割」を判定する。
//   { role: "variable" }
//   { role: "functionDef", funcName, paramName, rhs }
//   { role: "functionCall", funcName, argTokens }
// 横・縦どちらのrunにも属しうるので両方調べ、関数としての役割が見つかればそちらを優先する。
function classifyLetterOccurrence(block) {
  const runs = getRuns();
  let variableFallback = null;
  for (const run of runs) {
    if (!run.blocks.includes(block)) continue;
    const tokens = tokenizeRun(run);
    const idx = tokenIndexOfBlock(run.blocks, block);
    if (idx === -1 || tokens[idx].t !== "var") continue;

    const followedByCall = tokens[idx + 1] && tokens[idx + 1].t === "lparen";
    if (!followedByCall) {
      variableFallback = variableFallback || { role: "variable" };
      continue;
    }

    // 関数定義そのものかどうか： var(0) lparen var(2) rparen assign ... が、
    // ちょうどこのトークン位置(idx=0)から始まっている場合
    if (
      idx === 0 &&
      tokens.length >= 5 &&
      tokens[1].t === "lparen" &&
      tokens[2].t === "var" &&
      tokens[3].t === "rparen" &&
      tokens[4].t === "assign"
    ) {
      return { role: "functionDef", funcName: tokens[0].name, paramName: tokens[2].name, rhs: tokens.slice(5) };
    }

    // それ以外は呼び出し：引数部分のトークン列を括弧の対応から取り出す
    const closeIdx = matchingRParenIndex(tokens, idx + 1);
    if (closeIdx === -1) continue;
    const argTokens = tokens.slice(idx + 2, closeIdx);
    return { role: "functionCall", funcName: block.value, argTokens };
  }
  return variableFallback || { role: "variable" };
}

function tokensToDisplayString(tokens) {
  const OP_DISPLAY = { "+": "+", "-": "-", "*": "×", "/": "÷" };
  return tokens
    .map((t) => {
      if (t.t === "num") return String(t.v);
      if (t.t === "var") return t.name;
      if (t.t === "op") return OP_DISPLAY[t.v] || t.v;
      if (t.t === "lparen") return "(";
      if (t.t === "rparen") return ")";
      return "";
    })
    .join("");
}

/* ---- 文字ブロックの値ツールチップ：ホバー／長押しで表示する ---- */
let suppressNextLetterClick = false;

function ensureVarTooltipEl() {
  let tip = document.getElementById("var-tooltip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "var-tooltip";
    tip.className = "var-tooltip";
    document.body.appendChild(tip);
  }
  return tip;
}

function showVarTooltip(block, anchorEl) {
  const occurrence = classifyLetterOccurrence(block);
  const tip = ensureVarTooltipEl();
  tip.innerHTML = "";
  tip.classList.remove("tooltip-danger");

  const valueLine = document.createElement("div");
  valueLine.className = "var-tooltip-value";

  if (occurrence.role === "functionDef") {
    // 入力が無い状態＝関数そのものの定義を、そのまま読みやすい形で出す
    valueLine.textContent = `${occurrence.funcName}(${occurrence.paramName})=${tokensToDisplayString(occurrence.rhs)}`;
  } else if (occurrence.role === "functionCall") {
    const { varValues, funcs } = resolveVariables();
    let argVal;
    try {
      argVal = evalExpr(occurrence.argTokens, varValues, funcs);
    } catch (e) {
      valueLine.textContent = `${occurrence.funcName}(?)=undefined`;
      tip.appendChild(valueLine);
      positionTooltip(tip, anchorEl);
      return;
    }
    const fn = funcs[occurrence.funcName];
    let outVal;
    try {
      if (!fn) throw new Error("undefined function");
      outVal = evalExpr(fn.rhs, { ...varValues, [fn.paramName]: argVal }, funcs);
      valueLine.textContent = `${occurrence.funcName}(${argVal})=${outVal}`;
    } catch (e) {
      valueLine.textContent = `${occurrence.funcName}(${argVal})=undefined`;
    }
  } else {
    const status = explainVariableStatus(block.value);
    valueLine.textContent = `${block.value}=${status.defined ? status.value : "undefined"}`;
  }

  tip.appendChild(valueLine);
  positionTooltip(tip, anchorEl);
}

// 失敗している式（代入がまだ成立していない×印のついた式）にホバー／長押しした時、
// 「なぜ成立していないか」を式そのものへの注釈として出す（変数個別の注釈とは別）。
function showEquationFailureTooltip(reasonText, anchorEl) {
  const tip = ensureVarTooltipEl();
  tip.innerHTML = "";
  tip.classList.add("tooltip-danger");

  const line = document.createElement("div");
  line.className = "var-tooltip-reason";
  line.textContent = reasonText;
  tip.appendChild(line);

  positionTooltip(tip, anchorEl);
}

function positionTooltip(tip, anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  tip.style.left = `${rect.left + rect.width / 2}px`;
  tip.style.top = `${rect.top - 8}px`;
  tip.classList.add("visible");
}

function hideVarTooltip() {
  const tip = document.getElementById("var-tooltip");
  if (tip) tip.classList.remove("visible");
}

const LONG_PRESS_MS = 500;

function attachVarTooltipHandlers(block, el) {
  // デスクトップ：ホバーで表示
  el.addEventListener("mouseenter", () => showVarTooltip(block, el));
  el.addEventListener("mouseleave", hideVarTooltip);

  // タッチ：一定時間押し続けたら表示。長押しと判定した場合は、その後に来るクリック
  // （＝移動のための選択）が誤発火しないように抑制する。
  let touchTimer = null;
  let longPressed = false;
  el.addEventListener(
    "touchstart",
    () => {
      longPressed = false;
      clearTimeout(touchTimer);
      touchTimer = setTimeout(() => {
        longPressed = true;
        showVarTooltip(block, el);
      }, LONG_PRESS_MS);
    },
    { passive: true }
  );
  el.addEventListener("touchmove", () => clearTimeout(touchTimer));
  el.addEventListener("touchend", (ev) => {
    clearTimeout(touchTimer);
    if (longPressed) {
      ev.preventDefault();
      suppressNextLetterClick = true;
      hideVarTooltip();
    }
  });
  el.addEventListener("touchcancel", () => {
    clearTimeout(touchTimer);
    hideVarTooltip();
  });
}

// 失敗している式（×印）の当たり判定に、ホバー／長押しで理由を出すハンドラを付ける
function attachEquationFailureTooltipHandlers(hitzone, reasonText) {
  hitzone.addEventListener("mouseenter", () => showEquationFailureTooltip(reasonText, hitzone));
  hitzone.addEventListener("mouseleave", hideVarTooltip);

  let touchTimer = null;
  hitzone.addEventListener(
    "touchstart",
    (ev) => {
      ev.stopPropagation();
      clearTimeout(touchTimer);
      touchTimer = setTimeout(() => showEquationFailureTooltip(reasonText, hitzone), LONG_PRESS_MS);
    },
    { passive: true }
  );
  hitzone.addEventListener("touchmove", () => clearTimeout(touchTimer));
  hitzone.addEventListener("touchend", (ev) => {
    clearTimeout(touchTimer);
    ev.stopPropagation();
    hideVarTooltip();
  });
  hitzone.addEventListener("touchcancel", () => clearTimeout(touchTimer));
}

function renderHighlights() {
  // 既存のハイライトを削除
  els.board.querySelectorAll(".reachable-cell").forEach((n) => n.remove());
  for (const key of state.reachable.keys()) {
    const [x, y] = key.split(",").map(Number);
    const cell = document.createElement("div");
    cell.className = "reachable-cell";
    cell.style.left = cellPx(x);
    cell.style.top = cellPx(y);
    cell.style.width = "var(--cell-size)";
    cell.style.height = "var(--cell-size)";
    cell.addEventListener("click", (ev) => {
      ev.stopPropagation();
      onReachableCellClick(x, y);
    });
    els.board.appendChild(cell);
  }
}

// 成立している等式を、その式全体を囲む枠としてハイライトする。
// 代入(:=)が成立しているものは、色違いの枠でハイライトする。
function renderEquationGlows() {
  els.board.querySelectorAll(".equation-glow, .assignment-glow, .assignment-conflict").forEach((n) => n.remove());
  const PAD = 6; // ブロックの外側にはみ出させる分（px）。これがないと枠がブロックの下に隠れて見えない。

  const drawGlow = (run, className) => {
    const xs = run.blocks.map((b) => b.x);
    const ys = run.blocks.map((b) => b.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const spanX = Math.max(...xs) - minX + 1;
    const spanY = Math.max(...ys) - minY + 1;

    const glow = document.createElement("div");
    glow.className = className;
    glow.style.left = `calc(${cellPx(minX)} - ${PAD}px)`;
    glow.style.top = `calc(${cellPx(minY)} - ${PAD}px)`;
    glow.style.width = `calc(var(--cell-size) * ${spanX} + ${PAD * 2}px)`;
    glow.style.height = `calc(var(--cell-size) * ${spanY} + ${PAD * 2}px)`;
    els.board.appendChild(glow);
    return glow;
  };

  for (const run of getSatisfiedRuns()) drawGlow(run, "equation-glow");
  for (const run of getSatisfiedAssignmentRuns()) drawGlow(run, "assignment-glow");
  // 完成しているのに成立していない代入・関数定義（重複・右辺が未解決・入力変数がすでに変数として
  // 使われている 等）には×印をつける。×の中央に小さな当たり判定を置き、そこにホバー／長押しすると
  // 「式全体」への注釈として理由が出る（枠全体をホバー対象にすると、その下のブロックがクリック
  // できなくなってしまうため）。ここは1回のresolveVariables()の結果だけを使う（run同士の参照を
  // 別呼び出しとまたいで突き合わせようとすると、getRunsが毎回新しいオブジェクトを作るため
  // 一致しなくなるので注意）。
  const { varValues, funcs, varCandidates, funcCandidates, satisfiedVarRunIds, satisfiedFuncRunIds, nameCounts, funcNameCounts } =
    resolveVariables();
  const allCandidates = [...varCandidates, ...funcCandidates];
  const satisfiedAll = new Set([...satisfiedVarRunIds, ...satisfiedFuncRunIds]);
  for (const cand of allCandidates) {
    if (satisfiedAll.has(cand.run)) continue;
    const box = drawGlow(cand.run, "assignment-conflict");
    const hitzone = document.createElement("div");
    hitzone.className = "assignment-conflict-hitzone";
    box.appendChild(hitzone);
    const reason = explainFailureForCandidate(cand, varValues, funcs, nameCounts, funcNameCounts);
    attachEquationFailureTooltipHandlers(hitzone, reason);
  }
}

// まだ機能していない（式が成立していない）「＝」ブロックに、赤みの色と！マークをつける。
// バッジはブロックの子要素にはせず、盤面に直接重ねる独立した要素にする。
// （子要素のままだと、はみ出た部分が隣のブロックの下に隠れることがあるため。
//   独立させて高いz-indexを持たせることで常に最前面に表示する。）
function updateEqualsBlockStates() {
  const runs = getRuns();
  const { varValues, funcs } = resolveVariables();
  els.board.querySelectorAll(".eq-warning-badge").forEach((n) => n.remove());

  for (const block of Object.values(state.blocks)) {
    if (!(block.type === "symbol" && block.value === "=")) continue;
    const el = document.getElementById(`block-${block.id}`);
    if (!el) continue;

    const wantDir = (block.orientation || "horizontal") === "horizontal" ? "h" : "v";
    const run = runs.find((r) => r.dir === wantDir && r.blocks.includes(block));
    const satisfied = !!run && checkRun(run, varValues, funcs);

    el.classList.toggle("eq-unsatisfied", !satisfied);
    if (!satisfied) {
      const badge = document.createElement("div");
      badge.className = "eq-warning-badge";
      // ＝ブロックの右上の「角」ちょうどだと半分がブロックの外にはみ出してしまい、
      // どの＝についているか分かりにくいので、ブロック側に少し寄せて重なりを増やす。
      badge.style.left = `calc(${cellPx(block.x + 1)} - var(--cell-size) * 0.27)`;
      badge.style.top = `calc(${cellPx(block.y)} - var(--cell-size) * 0.07)`;
      els.board.appendChild(badge);
    }
  }
}

function refreshSelectedVisual() {
  els.board.querySelectorAll(".block").forEach((n) => n.classList.remove("selected"));
  if (state.selectedId) {
    const el = document.getElementById(`block-${state.selectedId}`);
    if (el) el.classList.add("selected");
  }
}

/* ---------------- 6. 操作 ---------------- */

function onBlockClick(blockId) {
  if (state.animating) return;
  if (state.selectedId === blockId) {
    // 同じブロックをもう一度クリック→選択解除
    deselect();
    return;
  }
  selectBlock(blockId);
}

function selectBlock(blockId) {
  const block = state.blocks[blockId];
  state.selectedId = blockId;
  const parentMap = computeReachable(block.x, block.y);
  state.reachable = parentMap;
  refreshSelectedVisual();
  renderHighlights();
}

function deselect() {
  state.selectedId = null;
  state.reachable = new Map();
  refreshSelectedVisual();
  renderHighlights();
}

function onReachableCellClick(x, y) {
  if (state.animating || !state.selectedId) return;
  const key = `${x},${y}`;
  if (!state.reachable.has(key)) return;
  const blockId = state.selectedId;
  const block = state.blocks[blockId];
  const from = { x: block.x, y: block.y };
  const path = reconstructPath(state.reachable, x, y);

  // グリッド状態を更新
  state.grid[from.y][from.x] = null;
  state.grid[y][x] = blockId;
  block.x = x;
  block.y = y;

  state.history.push({ blockId, from, to: { x, y }, path });
  els.btnUndo.disabled = false;

  deselect();
  animateAlongPath(blockId, path).then(() => {
    renderEquationGlows();
    updateEqualsBlockStates();
    if (checkWin()) showClear();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const STEP_MS = 110;

async function animateAlongPath(blockId, path) {
  state.animating = true;
  const el = document.getElementById(`block-${blockId}`);
  for (const step of path) {
    if (el) {
      el.style.left = cellPx(step.x);
      el.style.top = cellPx(step.y);
    }
    await sleep(STEP_MS);
  }
  state.animating = false;
}

async function undo() {
  if (state.animating || !state.history.length) return;
  const move = state.history.pop();
  if (!state.history.length) els.btnUndo.disabled = true;

  const block = state.blocks[move.blockId];
  state.grid[move.to.y][move.to.x] = null;
  state.grid[move.from.y][move.from.x] = move.blockId;
  block.x = move.from.x;
  block.y = move.from.y;

  deselect();

  const forwardFull = [move.from, ...move.path];
  const backwardPath = [...forwardFull].reverse().slice(1);
  await animateAlongPath(move.blockId, backwardPath);
  renderEquationGlows();
  updateEqualsBlockStates();
}

function resetLevel() {
  if (state.animating) return;
  const meta = state.levelsMeta.find((m) => m.id === state.level.id);
  openLevel(meta, true);
}

/* ---------------- 7. 画面遷移・初期化 ---------------- */

function showScreen(name) {
  const isGame = name === "game";
  els.screenSelect.hidden = isGame;
  els.screenGame.hidden = !isGame;
  els.header.hidden = !isGame;
}

async function openLevel(meta, skipOverlay) {
  await loadLevel(meta);
  els.levelName.textContent = meta.name;
  els.levelHint.textContent = state.level.hint || "";
  els.btnUndo.disabled = true;
  if (!skipOverlay) els.clearOverlay.hidden = true;
  showScreen("game");
  renderBoard();
  renderHighlights();
  renderEquationGlows();
  updateEqualsBlockStates();
}

function showClear() {
  state.cleared.add(state.level.id);
  saveClearedToStorage();
  renderClearPreview();
  els.clearOverlay.hidden = false;
  const idx = state.levelsMeta.findIndex((m) => m.id === state.level.id);
  const hasNext = idx >= 0 && idx < state.levelsMeta.length - 1;
  els.btnNext.hidden = !hasNext;
  // 次のステージが無い（最終ステージ）ときは「もう一度遊ぶ」だけが残るので、
  // 目立たないゴーストボタンのままだと押せるボタンがあることに気づきにくい。
  // その場合は「もう一度遊ぶ」を主役のボタン見た目に切り替える。
  els.btnReplay.classList.toggle("btn-primary", !hasNext);
  els.btnReplay.classList.toggle("btn-ghost", hasNext);
}

// クリア画面に、完成した盤面のミニプレビューを描画する
function renderClearPreview() {
  const container = els.clearPreview;
  container.innerHTML = "";

  const maxW = 260;
  const maxH = 170;
  const size = Math.max(8, Math.min(24, Math.floor(Math.min(maxW / state.width, maxH / state.height))));
  container.style.setProperty("--cell-size", `${size}px`);
  container.style.width = `${size * state.width}px`;
  container.style.height = `${size * state.height}px`;

  for (const block of Object.values(state.blocks)) {
    const el = renderBlockEl(block);
    el.classList.remove("selected");
    // cloneNodeするとクリックイベントリスナーは複製されないため、
    // 見本表示として安全に（操作できない状態で）使い回せる。
    container.appendChild(el.cloneNode(true));
  }
  renderEdges(container);
}

function goToSelect() {
  showScreen("select");
  renderLevelSelect();
}

function bindEvents() {
  els.btnBack.addEventListener("click", goToSelect);
  els.btnUndo.addEventListener("click", undo);
  els.btnReset.addEventListener("click", resetLevel);
  els.btnReplay.addEventListener("click", () => {
    els.clearOverlay.hidden = true;
    resetLevel();
  });
  els.btnNext.addEventListener("click", () => {
    const idx = state.levelsMeta.findIndex((m) => m.id === state.level.id);
    const next = state.levelsMeta[idx + 1];
    els.clearOverlay.hidden = true;
    if (next) openLevel(next);
  });
  els.btnClearToSelect.addEventListener("click", () => {
    els.clearOverlay.hidden = true;
    goToSelect();
  });
  els.board.addEventListener("click", () => {
    // 盤面の空白部分をクリックしたら選択解除
    if (state.selectedId) deselect();
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!els.screenGame.hidden) renderBoard();
    }, 120);
  });
}

async function init() {
  cacheEls();
  loadClearedFromStorage();
  bindEvents();
  try {
    await loadLevelsMeta();
    renderLevelSelect();
  } catch (e) {
    els.levelList.innerHTML =
      '<p class="loading">ステージデータを読み込めませんでした。ローカルサーバー経由（例: python -m http.server）で開いているか確認してください。</p>';
    console.error(e);
  }
}

document.addEventListener("DOMContentLoaded", init);