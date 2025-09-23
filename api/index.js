// api/index.js
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ------------ 小ユーティリティ ------------
const num = (v) => (v == null ? NaN : typeof v === "number" ? v : parseFloat(v));
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// 安全にボディを取得（Vercelで稀にrawのことがあるため保険）
async function getBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

// ------------ インジケーター実装 ------------
function SMA(values, period) {
  const out = Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v)) sum += v;
    if (i >= period) {
      const old = values[i - period];
      if (Number.isFinite(old)) sum -= old;
    }
    out[i] = i >= period - 1 ? sum / period : null;
  }
  return out;
}

function EMA(values, period) {
  const out = Array(values.length).fill(null);
  if (period <= 0) return out;
  const k = 2 / (period + 1);
  let emaPrev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      out[i] = emaPrev;
      continue;
    }
    if (emaPrev == null) {
      // 最初のEMAはSMAで初期化
      const window = values.slice(0, i + 1);
      if (window.length >= period && window.every(Number.isFinite)) {
        emaPrev = mean(window.slice(-period));
        out[i] = emaPrev;
      } else {
        out[i] = null;
      }
    } else {
      emaPrev = v * k + emaPrev * (1 - k);
      out[i] = emaPrev;
    }
  }
  return out;
}

function RSI(closes, period = 14) {
  const out = Array(closes.length).fill(null);
  if (period <= 0) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    gain += ch > 0 ? ch : 0;
    loss += ch < 0 ? -ch : 0;
    if (i === period) {
      const avgGain = gain / period;
      const avgLoss = loss / period;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      out[i] = 100 - 100 / (1 + rs);
    } else if (i > period) {
      const ch2 = closes[i] - closes[i - 1];
      const g = ch2 > 0 ? ch2 : 0;
      const l = ch2 < 0 ? -ch2 : 0;
      // Wilder 平滑化
      const prev = out[i - 1];
      // 直前の平均を保持しない簡易版：前回のavgを再計算せず近似（十分実用）
      // 厳密にやるならavgGain/avgLossを配列で持つ
      // ここでは精度と簡潔さのバランスで実装
      gain = (gain - (closes[i - period] > closes[i - period - 1] ? closes[i - period] - closes[i - period - 1] : 0)) + g;
      loss = (loss - (closes[i - period] < closes[i - period - 1] ? closes[i - period - 1] - closes[i - period] : 0)) + l;

      const avgGain = gain / period;
      const avgLoss = loss / period;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}

function MACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = EMA(closes, fast);
  const emaSlow = EMA(closes, slow);
  const macd = closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  );
  const signalArr = EMA(macd.map((v) => (v == null ? NaN : v)), signal);
  const hist = macd.map((v, i) =>
    v != null && signalArr[i] != null ? v - signalArr[i] : null
  );
  return { macd, signal: signalArr, hist };
}

function Bollinger(closes, length = 20, std = 2) {
  const ma = SMA(closes, length);
  const out = { upper: Array(closes.length).fill(null), middle: ma, lower: Array(closes.length).fill(null) };
  for (let i = 0; i < closes.length; i++) {
    if (i < length - 1) continue;
    const win = closes.slice(i - length + 1, i + 1);
    if (win.some((v) => !Number.isFinite(v))) continue;
    const m = ma[i];
    const variance = mean(win.map((v) => (v - m) ** 2));
    const sd = Math.sqrt(variance);
    out.upper[i] = m + std * sd;
    out.lower[i] = m - std * sd;
  }
  return out;
}

function TR(high, low, closePrev) {
  return Math.max(high - low, Math.abs(high - closePrev), Math.abs(low - closePrev));
}

function ATR(highs, lows, closes, period = 14) {
  const out = Array(closes.length).fill(null);
  let prevClose = closes[0];
  let trSum = 0;
  for (let i = 1; i < closes.length; i++) {
    const tr = TR(highs[i], lows[i], prevClose);
    prevClose = closes[i];
    trSum += tr;
    if (i === period) out[i] = trSum / period;
    else if (i > period) {
      // Wilder smoothing
      out[i] = (out[i - 1] * (period - 1) + tr) / period;
    }
  }
  return out;
}

function ADX(highs, lows, closes, period = 14) {
  // 参考実装（Wilder方式）
  const len = closes.length;
  const out = Array(len).fill(null);
  if (len < period + 2) return out;

  const trArr = Array(len).fill(0);
  const plusDM = Array(len).fill(0);
  const minusDM = Array(len).fill(0);

  for (let i = 1; i < len; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    trArr[i] = TR(highs[i], lows[i], closes[i - 1]);
  }

  // Wilder smoothing
  const smooth = (arr, p) => {
    const res = Array(len).fill(null);
    let sum = 0;
    for (let i = 1; i <= p; i++) sum += arr[i];
    res[p] = sum;
    for (let i = p + 1; i < len; i++) {
      res[i] = res[i - 1] - res[i - 1] / p + arr[i];
    }
    return res;
  };

  const tr14 = smooth(trArr, period);
  const plusDM14 = smooth(plusDM, period);
  const minusDM14 = smooth(minusDM, period);

  const plusDI = Array(len).fill(null);
  const minusDI = Array(len).fill(null);
  const DX = Array(len).fill(null);

  for (let i = period; i < len; i++) {
    if (!tr14[i] || tr14[i] === 0) continue;
    plusDI[i] = 100 * (plusDM14[i] / tr14[i]);
    minusDI[i] = 100 * (minusDM14[i] / tr14[i]);
    DX[i] = 100 * (Math.abs(plusDI[i] - minusDI[i]) / (plusDI[i] + minusDI[i]));
  }

  // ADXはDXのWilder平均
  let adx = null;
  for (let i = period * 2; i < len; i++) {
    if (adx == null) {
      const window = DX.slice(i - period + 1, i + 1).filter(Number.isFinite);
      if (window.length === period) {
        adx = mean(window);
        out[i] = adx;
      }
    } else {
      adx = (adx * (period - 1) + DX[i]) / period;
      out[i] = adx;
    }
  }
  return out;
}

function Stoch(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
  const k = Array(closes.length).fill(null);
  const d = Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (i < kPeriod - 1) continue;
    const hh = Math.max(...highs.slice(i - kPeriod + 1, i + 1));
    const ll = Math.min(...lows.slice(i - kPeriod + 1, i + 1));
    const c = closes[i];
    if (!Number.isFinite(hh) || !Number.isFinite(ll) || hh === ll) continue;
    k[i] = ((c - ll) / (hh - ll)) * 100;
  }
  const dArr = SMA(k.map((v) => (v == null ? NaN : v)), dPeriod);
  for (let i = 0; i < closes.length; i++) d[i] = dArr[i];
  return { k, d };
}

function Ichimoku(highs, lows, conv = 9, base = 26, spanB = 52, shift = 26) {
  const len = highs.length;
  const convLine = Array(len).fill(null);
  const baseLine = Array(len).fill(null);
  const spanA = Array(len).fill(null);
  const spanBArr = Array(len).fill(null);

  const HH = (arr, i, p) => Math.max(...arr.slice(i - p + 1, i + 1));
  const LL = (arr, i, p) => Math.min(...arr.slice(i - p + 1, i + 1));

  for (let i = 0; i < len; i++) {
    if (i >= conv - 1) convLine[i] = (HH(highs, i, conv) + LL(lows, i, conv)) / 2;
    if (i >= base - 1) baseLine[i] = (HH(highs, i, base) + LL(lows, i, base)) / 2;
    if (convLine[i] != null && baseLine[i] != null) spanA[i + shift] = (convLine[i] + baseLine[i]) / 2;
    if (i >= spanB - 1) spanBArr[i + shift] = (HH(highs, i, spanB) + LL(lows, i, spanB)) / 2;
  }

  return { conversion: convLine, base: baseLine, spanA, spanB: spanBArr };
}

// ------------ ルーティング ------------
app.get("/helpers/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.post("/helpers/indicators", async (req, res) => {
  try {
    const body = await getBody(req);
    const { instrument, granularity, candles, params = {} } = body;

    if (!instrument || !granularity || !Array.isArray(candles))
      return res.status(400).json({ error: "Bad request: missing fields" });

    // 入力の正規化
    const t = candles.map((c) => c.time);
    const o = candles.map((c) => num(c?.mid?.o));
    const h = candles.map((c) => num(c?.mid?.h));
    const l = candles.map((c) => num(c?.mid?.l));
    const c = candles.map((c_) => num(c_?.mid?.c));

    if (c.some((x) => !Number.isFinite(x)))
      return res.status(422).json({ error: "Unprocessable: close values contain NaN" });

    // デフォ設定
    const emaList = Array.isArray(params.ema) ? params.ema : [20, 50];
    const rsiLen = params.rsi ?? 14;
    const macdCfg = { fast: 12, slow: 26, signal: 9, ...(params.macd || {}) };
    const bbCfg = { length: 20, std: 2, ...(params.bb || {}) };
    const atrLen = params.atr ?? 14;
    const adxLen = params.adx ?? 14;
    const stochCfg = { k: 14, d: 3, ...(params.stoch || {}) };
    const ichiCfg = { conv: 9, base: 26, spanB: 52, shift: 26, ...(params.ichimoku || {}) };

    // 本数チェック（“最小60本”推奨、SMA200やIchimoku雲はさらに必要）
    if (candles.length < 60)
      return res.status(422).json({ error: "Need at least 60 candles for stable calculations" });

    // 計算
    const out = { instrument, granularity, length: candles.length, lastTime: t.at(-1) };

    // 移動平均
    out.sma = {};
    if (emaList.includes(200)) out.sma["200"] = SMA(c, 200);
    out.ema = {};
    for (const p of emaList) out.ema[String(p)] = EMA(c, p);

    // RSI / MACD / BB
    out.rsi = RSI(c, rsiLen);
    out.macd = MACD(c, macdCfg.fast, macdCfg.slow, macdCfg.signal);
    out.bb = Bollinger(c, bbCfg.length, bbCfg.std);

    // ATR / ADX
    out.atr = ATR(h, l, c, atrLen);
    out.adx = ADX(h, l, c, adxLen);

    // Stochastic
    out.stoch = Stoch(h, l, c, stochCfg.k, stochCfg.d);

    // Ichimoku
    out.ichimoku = Ichimoku(h, l, ichiCfg.conv, ichiCfg.base, ichiCfg.spanB, ichiCfg.shift);

    // 直近サマリ（表示・判定に便利）
    const idx = candles.length - 1;
    const pick = (arr) => (Array.isArray(arr) ? arr[idx] ?? null : null);
    const last = {
      time: t[idx],
      open: o[idx],
      high: h[idx],
      low: l[idx],
      close: c[idx],
      ema: Object.fromEntries(Object.entries(out.ema).map(([k, v]) => [k, pick(v)])),
      sma200: out.sma?.["200"] ? pick(out.sma["200"]) : null,
      rsi: pick(out.rsi),
      macd: { macd: pick(out.macd.macd), signal: pick(out.macd.signal), hist: pick(out.macd.hist) },
      bb: { upper: pick(out.bb.upper), middle: pick(out.bb.middle), lower: pick(out.bb.lower) },
      atr: pick(out.atr),
      adx: pick(out.adx),
      stoch: { k: pick(out.stoch.k), d: pick(out.stoch.d) },
      ichimoku: {
        conversion: pick(out.ichimoku.conversion),
        base: pick(out.ichimoku.base),
        spanA: pick(out.ichimoku.spanA),
        spanB: pick(out.ichimoku.spanB)
      }
    };

    res.json({ meta: { instrument, granularity, candles: candles.length }, last, series: out });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error", detail: String(e) });
  }
});

// ------------ エクスポート ------------
export default app;
