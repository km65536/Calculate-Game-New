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
  const level = await fetchJSON(meta.file);
  state.level = level;
  state.width = level.width;
  state.height = level.height;
  state.blocks = {};
  for (const b of level.blocks) {
    state.blocks[b.id] = { ...b };
  }
  state.grid = buildGrid();
  state.selectedId = null;
  state.reachable = new Map();
  state.history = [];
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

// 指定ブロックが「曲がりながら」到達できる空きマスを幅優先探索で全て求める。
// 経路上のどのマスも、壁・他ブロック（動かせる／動かせない問わず）で塞がれていたら通れない。
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
      if (state.grid[ny][nx] !== null) continue; // 何かで塞がっている
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

function getRuns() {
  const runs = [];
  for (let y = 0; y < state.height; y++) {
    let run = [];
    for (let x = 0; x < state.width; x++) {
      const id = state.grid[y][x];
      const b = id ? state.blocks[id] : null;
      if (b && b.type !== "wall") {
        run.push(b);
      } else {
        if (run.length) runs.push({ dir: "h", blocks: run });
        run = [];
      }
    }
    if (run.length) runs.push({ dir: "h", blocks: run });
  }
  for (let x = 0; x < state.width; x++) {
    let run = [];
    for (let y = 0; y < state.height; y++) {
      const id = state.grid[y][x];
      const b = id ? state.blocks[id] : null;
      if (b && b.type !== "wall") {
        run.push(b);
      } else {
        if (run.length) runs.push({ dir: "v", blocks: run });
        run = [];
      }
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
    } else {
      flushNum();
      if (b.value === "=") tokens.push({ t: "eq" });
      else if (b.value === "(") tokens.push({ t: "lparen" });
      else if (b.value === ")") tokens.push({ t: "rparen" });
      else tokens.push({ t: "op", v: OP_MAP[b.value] });
    }
  }
  flushNum();
  return tokens;
}

function evalExpr(tokens) {
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

function checkRun(run) {
  const tokens = tokenizeRun(run);
  const segments = [[]];
  for (const tk of tokens) {
    if (tk.t === "eq") segments.push([]);
    else segments[segments.length - 1].push(tk);
  }
  if (segments.length < 2) return false;
  try {
    const values = segments.map((seg) => evalExpr(seg));
    const eps = 1e-9;
    for (let i = 1; i < values.length; i++) {
      if (Math.abs(values[i] - values[0]) > eps) return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

function checkWin() {
  const runs = getRuns();
  const checked = runs.filter(runHasOrientedEquals);
  if (checked.length === 0) return false;
  return checked.every((r) => checkRun(r) === true);
}

/* ---------------- 5. 描画 ---------------- */

const els = {};
function cacheEls() {
  els.header = document.getElementById("game-header-actions");
  els.screenSelect = document.getElementById("screen-select");
  els.screenGame = document.getElementById("screen-game");
  els.levelList = document.getElementById("level-list");
  els.levelName = document.getElementById("current-level-name");
  els.levelHint = document.getElementById("level-hint");
  els.boardWrap = document.getElementById("board-wrap");
  els.board = document.getElementById("board");
  els.clearOverlay = document.getElementById("clear-overlay");
  els.btnBack = document.getElementById("btn-back");
  els.btnUndo = document.getElementById("btn-undo");
  els.btnReset = document.getElementById("btn-reset");
  els.btnNext = document.getElementById("btn-next");
  els.btnReplay = document.getElementById("btn-replay");
}

function symbolGlyph(value) {
  return value; // '+','-','×','÷','(',')','='
}

function updateCellSize() {
  const available = Math.min(els.boardWrap.clientWidth || 640, 640);
  const size = Math.max(30, Math.min(64, Math.floor(available / state.width)));
  document.documentElement.style.setProperty("--cell-size", `${size}px`);
}

function cellPx(n) {
  return `calc(var(--cell-size) * ${n})`;
}

function renderLevelSelect() {
  els.levelList.innerHTML = "";
  for (const meta of state.levelsMeta) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "level-card";
    const cleared = state.cleared.has(meta.id);
    card.innerHTML = `
      <span class="num">STAGE</span>
      <span class="name">${escapeHTML(meta.name)}</span>
      ${cleared ? '<span class="status">✓ CLEAR</span>' : ""}
    `;
    card.addEventListener("click", () => openLevel(meta));
    els.levelList.appendChild(card);
  }
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

  const wallEdgeCache = computeWallEdges();

  for (const block of Object.values(state.blocks)) {
    els.board.appendChild(renderBlockEl(block, wallEdgeCache));
  }
}

function computeWallEdges() {
  // 壁ブロックごとに、隣が壁でない方向を赤枠として出す（連結した壁は外周だけ赤くなる）
  const edges = {};
  for (const b of Object.values(state.blocks)) {
    if (b.type !== "wall") continue;
    const isWall = (x, y) => {
      if (x < 0 || y < 0 || x >= state.width || y >= state.height) return false;
      const id = state.grid[y][x];
      return id && state.blocks[id].type === "wall";
    };
    edges[b.id] = {
      t: !isWall(b.x, b.y - 1),
      r: !isWall(b.x + 1, b.y),
      b: !isWall(b.x, b.y + 1),
      l: !isWall(b.x - 1, b.y),
    };
  }
  return edges;
}

function renderBlockEl(block, wallEdgeCache) {
  const el = document.createElement("div");
  el.id = `block-${block.id}`;
  el.style.left = cellPx(block.x);
  el.style.top = cellPx(block.y);
  el.style.width = "var(--cell-size)";
  el.style.height = "var(--cell-size)";

  if (block.type === "wall") {
    el.className = "block block-wall";
    const e = wallEdgeCache[block.id];
    if (e.t) el.classList.add("edge-t");
    if (e.r) el.classList.add("edge-r");
    if (e.b) el.classList.add("edge-b");
    if (e.l) el.classList.add("edge-l");
    return el;
  }

  const kind = block.type === "number" ? "block-number" : "block-symbol";
  el.className = `block ${kind} ${block.movable ? "movable" : "fixed"}`;

  const glyph = document.createElement("span");
  glyph.className = "symbol-glyph";
  if (block.type === "number") {
    glyph.textContent = String(block.value);
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
      onBlockClick(block.id);
    });
  }

  return el;
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
}

function showClear() {
  state.cleared.add(state.level.id);
  saveClearedToStorage();
  els.clearOverlay.hidden = false;
  const idx = state.levelsMeta.findIndex((m) => m.id === state.level.id);
  const hasNext = idx >= 0 && idx < state.levelsMeta.length - 1;
  els.btnNext.hidden = !hasNext;
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
