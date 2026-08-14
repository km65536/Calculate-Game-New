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
  levelsMeta: [],      // data/levels.json の中身
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

async function loadLevelsMeta() {
  const data = await fetchJSON("data/levels.json");
  state.levelsMeta = data.levels;
}

async function loadLevel(meta) {
  const def = await fetchJSON(meta.file);
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

// varValues: { 変数名: 数値 } 。省略した場合は変数を一切解決できないものとして評価する。
function evalExpr(tokens, varValues) {
  const vars = varValues || {};
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

function checkRun(run, varValues) {
  const tokens = tokenizeRun(run);
  const segments = [[]];
  for (const tk of tokens) {
    if (tk.t === "eq") segments.push([]);
    else segments[segments.length - 1].push(tk);
  }
  if (segments.length < 2) return false;
  try {
    const values = segments.map((seg) => evalExpr(seg, varValues));
    const eps = 1e-9;
    for (let i = 1; i < values.length; i++) {
      if (Math.abs(values[i] - values[0]) > eps) return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

// runが「代入として成立する形」かどうかを判定する:
//   左辺に文字ブロックがちょうど1つ、間に:=、右辺に何らかの式があること
function assignmentShape(run) {
  const tokens = tokenizeRun(run);
  const assignIdx = tokens.findIndex((t) => t.t === "assign");
  if (assignIdx !== 1) return null; // 左辺が「変数1つだけ」でない（:=の位置が1番目でない）
  if (tokens[0].t !== "var") return null;
  const rhs = tokens.slice(assignIdx + 1);
  if (rhs.length === 0) return null;
  if (rhs.some((t) => t.t === "assign" || t.t === "eq")) return null; // 右辺に=や:=が混ざるのは不正
  return { varName: tokens[0].name, rhs };
}

// 盤面上の全ての代入（:=）候補を集め、固定点反復で変数の値を確定させる。
// 例: x:=1, y:=x+1 のような依存関係も、収束するまで繰り返し評価することで解決する。
function resolveVariables() {
  const candidates = getRuns()
    .filter(runHasAssignment)
    .map((run) => ({ run, shape: assignmentShape(run) }))
    .filter((c) => c.shape !== null);

  // 同じ変数名に対する代入が2つ以上あれば「代入が失敗している」とみなし、
  // それらは値の確定に一切使わない（＝コンフリクト扱い）。
  const nameCounts = new Map();
  for (const c of candidates) {
    nameCounts.set(c.shape.varName, (nameCounts.get(c.shape.varName) || 0) + 1);
  }
  const conflictedNames = new Set([...nameCounts.entries()].filter(([, n]) => n > 1).map(([name]) => name));
  const conflictedRunIds = new Set(candidates.filter((c) => conflictedNames.has(c.shape.varName)).map((c) => c.run));

  const resolvable = candidates.filter((c) => !conflictedNames.has(c.shape.varName));

  const varValues = {};
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of resolvable) {
      if (Object.prototype.hasOwnProperty.call(varValues, c.shape.varName)) continue;
      try {
        const val = evalExpr(c.shape.rhs, varValues);
        varValues[c.shape.varName] = val;
        changed = true;
      } catch (e) {
        // まだ解決できない（未確定の変数を参照している等）。次の周回で再挑戦する。
      }
    }
  }

  // 最終的な varValues を使って、各候補（コンフリクトしていないもの）が
  // 「今、成立しているか」を個別に判定する
  const satisfiedRunIds = new Set();
  for (const c of resolvable) {
    try {
      evalExpr(c.shape.rhs, varValues);
      satisfiedRunIds.add(c.run);
    } catch (e) {
      // 未成立。何もしない。
    }
  }

  return { varValues, candidates, satisfiedRunIds, conflictedRunIds };
}

function checkWin() {
  const { varValues } = resolveVariables();
  const runs = getRuns();
  const checked = runs.filter(runHasOrientedEquals);
  if (checked.length === 0) return false;
  return checked.every((r) => checkRun(r, varValues) === true);
}

// 現在成立している等式（run）だけを抜き出す。ハイライト表示に使う。
function getSatisfiedRuns() {
  const { varValues } = resolveVariables();
  return getRuns().filter((r) => runHasOrientedEquals(r) && checkRun(r, varValues) === true);
}

// 現在成立している代入（run）だけを抜き出す。ハイライト表示に使う。
function getSatisfiedAssignmentRuns() {
  const { candidates, satisfiedRunIds } = resolveVariables();
  return candidates.filter((c) => satisfiedRunIds.has(c.run)).map((c) => c.run);
}

// 同じ変数に複数の代入が存在して失敗している（コンフリクトしている）runを抜き出す。×印の表示に使う。
function getConflictedAssignmentRuns() {
  const { candidates, conflictedRunIds } = resolveVariables();
  return candidates.filter((c) => conflictedRunIds.has(c.run)).map((c) => c.run);
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

/* ---- 文字ブロック（変数）の値ツールチップ：ホバー／長押しで x=6 のように表示する ---- */
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
  const { varValues } = resolveVariables();
  const has = Object.prototype.hasOwnProperty.call(varValues, block.value);
  const text = `${block.value}=${has ? varValues[block.value] : "undefined"}`;
  const tip = ensureVarTooltipEl();
  tip.textContent = text;
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
  };

  for (const run of getSatisfiedRuns()) drawGlow(run, "equation-glow");
  for (const run of getSatisfiedAssignmentRuns()) drawGlow(run, "assignment-glow");
  // 同じ変数への重複代入（失敗している代入）には×印をつける
  for (const run of getConflictedAssignmentRuns()) drawGlow(run, "assignment-conflict");
}

// まだ機能していない（式が成立していない）「＝」ブロックに、赤みの色と！マークをつける。
// バッジはブロックの子要素にはせず、盤面に直接重ねる独立した要素にする。
// （子要素のままだと、はみ出た部分が隣のブロックの下に隠れることがあるため。
//   独立させて高いz-indexを持たせることで常に最前面に表示する。）
function updateEqualsBlockStates() {
  const runs = getRuns();
  const { varValues } = resolveVariables();
  els.board.querySelectorAll(".eq-warning-badge").forEach((n) => n.remove());

  for (const block of Object.values(state.blocks)) {
    if (!(block.type === "symbol" && block.value === "=")) continue;
    const el = document.getElementById(`block-${block.id}`);
    if (!el) continue;

    const wantDir = (block.orientation || "horizontal") === "horizontal" ? "h" : "v";
    const run = runs.find((r) => r.dir === wantDir && r.blocks.includes(block));
    const satisfied = !!run && checkRun(run, varValues);

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