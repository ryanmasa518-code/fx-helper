// api/index.js
// FX Unified Helper (Indicators + OANDA Bridge)
// - /helpers/* : インジ計算・シグナル雛形・注文プレビュー・ジャーナル
// - /oanda/*   : OANDA LIVE ブリッジ（トークン/口座IDはサーバ側ENVから注入）
// Vercel: Node.js 18+, ESM。export default (req, res) でハンドラをエクスポート。

import express from "express";
import cors from "cors";

// ============== App bootstrap ==============
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// 小道具: 手動で raw body を取りたい場面向け（未使用でも残しておくと便利）
async function getBody(req) {
  if (req.body && Object.keys(req.body).length) return req.body;
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

// ============== Health ==============
app.get("/helpers/health", (_req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// ============== Indicator math utils ==============

// 数値配列化
function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}
function extractOHLC(candles) {
  const highs = [];
  const lows = [];
  const closes = [];
  const opens = [];
  const times = [];
  for (const c of candles) {
    const mid = c?.mid || {};
    const h = toNum(mid.h);
    const l = toNum(mid.l);
    const o = toNum(mid.o);
    const cl = toNum(mid.c);
    if (
      Number.isFinite(h) &&
      Number.isFinite(l) &&
      Number.isFinite(o) &&
      Number.isFinite(cl)
    ) {
      highs.push(h);
      lows.push(l);
      opens.push(o);
      closes.push(cl);
      times.push(c.time || "");
    }
  }
  return { highs, lows, closes, opens, times };
}

function sma(arr, len, i) {
  if (i + 1 < len) return NaN;
  let s = 0;
  for (let k = i - len + 1; k <= i; k++) s += arr[k];
  return s / len;
}

function stddev(arr, len, i) {
  if (i + 1 < len) return NaN;
  const m = sma(arr, len, i);
  let s = 0;
  for (let k = i - len + 1; k <= i; k++) {
    const d = arr[k] - m;
    s += d * d;
  }
  return Math.sqrt(s / len);
}

function emaSeries(arr, period) {
  const k = 2 / (period + 1);
  const out = new Array(arr.length).fill(NaN);
  let prev = NaN;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (!Number.isFinite(v)) continue;
    if (i === 0) {
      prev = v;
    } else {
      prev = v * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

// Wilder's RSI
function rsiLast(closes, period = 14) {
  if (closes.length < period + 1) return NaN;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gains += ch;
    else losses -= ch;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const gain = ch > 0 ? ch : 0;
    const loss = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// MACD
function macdLast(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const macdLine = closes.map((_, i) => emaFast[i] - emaSlow[i]);
  const signalLine = emaSeries(macdLine, signal);
  const i = closes.length - 1;
  const macd = macdLine[i];
  const sig = signalLine[i];
  return {
    macd,
    signal: sig,
    hist: macd - sig,
  };
}

// Bollinger Bands
function bbLast(closes, length = 20, stdevMult = 2) {
  const i = closes.length - 1;
  const middle = sma(closes, length, i);
  const sd = stddev(closes, length, i);
  if (!Number.isFinite(middle) || !Number.isFinite(sd))
    return { middle: NaN, upper: NaN, lower: NaN, width: NaN };
  const upper = middle + stdevMult * sd;
  const lower = middle - stdevMult * sd;
  return { middle, upper, lower, width: upper - lower };
}

// ATR
function atrLast(highs, lows, closes, period = 14) {
  if (highs.length < period + 1) return NaN;
  const trs = [];
  for (let i = 0; i < highs.length; i++) {
    if (i === 0) {
      trs.push(highs[i] - lows[i]);
    } else {
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
      trs.push(tr);
    }
  }
  // Wilder smoothing
  let atr = 0;
  // 初期値: period 本の平均
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trs[i];
  atr = sum / period;
  for (let i = period + 1; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

// ADX
function adxLast(highs, lows, closes, period = 14) {
  const n = highs.length;
  if (n < period + 2) return NaN;

  // TR, +DM, -DM
  const TR = new Array(n).fill(0);
  const PDM = new Array(n).fill(0);
  const NDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    TR[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    PDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    NDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  // Wilder smoothingの初期値は単純合計/period
  let ATR = 0,
    sPDM = 0,
    sNDM = 0;
  for (let i = 1; i <= period; i++) {
    ATR += TR[i];
    sPDM += PDM[i];
    sNDM += NDM[i];
  }
  ATR /= period;
  sPDM /= period;
  sNDM /= period;

  for (let i = period + 1; i < n; i++) {
    ATR = (ATR * (period - 1) + TR[i]) / period;
    sPDM = (sPDM * (period - 1) + PDM[i]) / period;
    sNDM = (sNDM * (period - 1) + NDM[i]) / period;
  }

  const pDI = (sPDM / ATR) * 100;
  const nDI = (sNDM / ATR) * 100;
  const dx = (Math.abs(pDI - nDI) / Math.max(pDI + nDI, 1e-12)) * 100;
  // ここでは最終ADXだけを返す（厳密にはDXを時系列平滑するが、簡便実装）
  return dx;
}

// ============== /helpers/indicators ==============
app.post("/helpers/indicators", async (req, res) => {
  try {
    const body = await getBody(req);
    const { instrument, granularity, candles, params = {} } = body || {};
    if (!instrument || !granularity || !Array.isArray(candles) || candles.length < 30) {
      return res
        .status(400)
        .json({ error: "instrument, granularity, candles(>=30) are required" });
    }

    const {
      ema: emaPeriods = [20, 50, 200],
      rsi: rsiPeriod = 14,
      macd: macdCfg = { fast: 12, slow: 26, signal: 9 },
      bb: bbCfg = { length: 20, std: 2 },
      atr: atrPeriod = 14,
      adx: adxPeriod = 14,
    } = params;

    const { highs, lows, closes } = extractOHLC(candles);
    if (closes.length < 30) {
      return res.status(422).json({ error: "Not enough valid candles" });
    }

    // EMA (複数期間)
    const emaOut = {};
    (Array.isArray(emaPeriods) ? emaPeriods : [emaPeriods]).forEach((p) => {
      const series = emaSeries(closes, p);
      emaOut[String(p)] = series[series.length - 1];
    });

    // RSI
    const rsi = rsiLast(closes, rsiPeriod);

    // MACD
    const macd = macdLast(closes, macdCfg.fast, macdCfg.slow, macdCfg.signal);

    // BB
    const bb = bbLast(closes, bbCfg.length, bbCfg.std);

    // ATR
    const atr = atrLast(highs, lows, closes, atrPeriod);

    // ADX
    const adx = adxLast(highs, lows, closes, adxPeriod);

    // A の仕様に合わせた薄い形で返す
    res.json({ ema: emaOut, rsi, macd, bb, atr, adx });
  } catch (e) {
    res.status(500).json({ error: e.message || "indicators failed" });
  }
});

// ============== /helpers/signal/preset（雛形） ==============
app.post("/helpers/signal/preset", async (req, res) => {
  try {
    const b = await getBody(req);
    const adx = b?.indicators?.trigger?.adx;
    const match = Number.isFinite(adx) && adx >= (b?.thresholds?.adxRange ?? 18);

    const suggestedEntry = match
      ? { direction: "long", entryZone: "BB middle ± ATR", invalidation: "BB lower割れ" }
      : { direction: "short", entryZone: "戻り売りゾーン", invalidation: "直近高値上抜け" };

    res.json({
      match: !!match,
      rationale: match ? ["ADX>=閾値でトレンド性あり"] : ["ADX<閾値で見送り"],
      suggestedEntry,
      riskHint: { rrEstimate: match ? 1.8 : 1.2, notes: ["イベント前はサイズ縮小"] },
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "signal failed" });
  }
});

// ============== /helpers/order/preview（雛形） ==============
app.post("/helpers/order/preview", async (req, res) => {
  try {
    const {
      instrument,
      direction,
      entryPrice,
      stopPrice,
      takeProfits = [],
      riskPct = 0.8,
      accountBalance,
      pipLocation = -2,
      atr,
    } = await getBody(req);

    if (
      [instrument, direction, entryPrice, stopPrice, accountBalance].some(
        (v) => v === undefined
      )
    ) {
      return res.status(400).json({ error: "missing fields" });
    }

    const pipSize = Math.pow(10, pipLocation);
    const stopPips = Math.abs(entryPrice - stopPrice) / pipSize;
    const riskAmount = accountBalance * (riskPct / 100);

    // 注意: 実売買用には通貨ペア別pip値と口座通貨を考慮する必要あり。
    // ここは雛形として、1単位あたり1pips=0.01の簡易近似。
    const valuePerUnitPerPip = 0.01;
    const units = Math.max(0, Math.floor(riskAmount / (stopPips * valuePerUnitPerPip)));

    res.json({
      units,
      notional: units * entryPrice,
      rrToEachTP: takeProfits.map(
        (tp) => Math.abs(tp - entryPrice) / Math.abs(entryPrice - stopPrice)
      ),
      ocoTemplate: {
        orderType: "LIMIT",
        entryPrice,
        stopLoss: stopPrice,
        takeProfits,
      },
      notes: atr ? [`ATR=${atr} に基づくバッファ検討`] : [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "order preview failed" });
  }
});

// ============== /helpers/journal/write（雛形） ==============
app.post("/helpers/journal/write", async (req, res) => {
  try {
    const { instrument, preset, entry, result } = await getBody(req);
    if (!instrument || !preset || !entry || !result) {
      return res.status(400).json({ saved: false, error: "missing fields" });
    }
    const id = `jrnl_${new Date().toISOString()}`;
    // 実保存は未実装（別サービスに保存する場合はここで呼ぶ）
    res.json({ saved: true, id });
  } catch (e) {
    res.status(500).json({ saved: false, error: e.message || "journal failed" });
  }
});

// ============== OANDA Bridge (LIVE/Practice 切替はENVで) ==============
const OANDA_ENV = process.env.OANDA_ENV || "live";
const OANDA_BASE =
  OANDA_ENV === "practice"
    ? "https://api-fxpractice.oanda.com"
    : "https://api-fxtrade.oanda.com";
const OANDA_TOKEN = process.env.OANDA_TOKEN;
const OANDA_ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;

function assertOandaEnv(res) {
  if (!OANDA_TOKEN || !OANDA_ACCOUNT_ID) {
    res
      .status(500)
      .json({ error: "OANDA env not set: OANDA_TOKEN / OANDA_ACCOUNT_ID" });
    return false;
  }
  return true;
}

async function oandaFetch(pathWithLeadingSlash, { query } = {}) {
  const url = new URL(OANDA_BASE + pathWithLeadingSlash);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${OANDA_TOKEN}` },
  });
  const txt = await r.text();
  let json;
  try {
    json = JSON.parse(txt);
  } catch {
    json = { raw: txt };
  }
  if (!r.ok) {
    const err = new Error(`OANDA ${r.status}`);
    err.status = r.status;
    err.body = json;
    throw err;
  }
  return json;
}

app.get("/oanda/account/summary", async (_req, res) => {
  if (!assertOandaEnv(res)) return;
  try {
    const data = await oandaFetch(`/v3/accounts/${OANDA_ACCOUNT_ID}/summary`);
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json(e.body || { error: e.message });
  }
});

app.get("/oanda/positions", async (_req, res) => {
  if (!assertOandaEnv(res)) return;
  try {
    const data = await oandaFetch(`/v3/accounts/${OANDA_ACCOUNT_ID}/positions`);
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json(e.body || { error: e.message });
  }
});

app.get("/oanda/pricing", async (req, res) => {
  if (!assertOandaEnv(res)) return;
  const { instruments } = req.query;
  if (!instruments)
    return res
      .status(400)
      .json({ error: "instruments required, e.g. EUR_USD,USD_JPY" });
  try {
    const data = await oandaFetch(
      `/v3/accounts/${OANDA_ACCOUNT_ID}/pricing`,
      { query: { instruments } }
    );
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json(e.body || { error: e.message });
  }
});

app.get("/oanda/candles", async (req, res) => {
  if (!assertOandaEnv(res)) return;
  const {
    instrument,
    granularity = "H1",
    count = 100,
    price = "M",
  } = req.query;
  if (!instrument)
    return res.status(400).json({ error: "instrument required, e.g. USD_JPY" });
  try {
    const data = await oandaFetch(`/v3/instruments/${instrument}/candles`, {
      query: { granularity, count, price },
    });
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json(e.body || { error: e.message });
  }
});

app.get("/oanda/transactions", async (req, res) => {
  if (!assertOandaEnv(res)) return;
  const { count = 10 } = req.query;
  try {
    const data = await oandaFetch(`/v3/accounts/${OANDA_ACCOUNT_ID}/transactions`, {
      query: { count },
    });
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json(e.body || { error: e.message });
  }
});

// ============== Vercel export ==============
export default (req, res) => app(req, res);
