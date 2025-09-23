import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// 認証（任意）：環境変数 HELPER_API_KEY を設定しておくと安全
app.use((req, res, next) => {
  const needKey = !!process.env.HELPER_API_KEY;
  if (!needKey) return next();
  const key = req.header("X-API-Key");
  if (key !== process.env.HELPER_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.get("/helpers/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// 簡易インジ計算（最小限の雛形）
function ema(values, period) {
  const k = 2 / (period + 1);
  let emaPrev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = [ ...Array(period-1).fill(null), emaPrev ];
  for (let i = period; i < values.length; i++) {
    emaPrev = values[i] * k + emaPrev * (1 - k);
    out.push(emaPrev);
  }
  return out;
}

function sma(values, period) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

// ここでは close 値だけで計算（必要に応じて拡張）
app.post("/helpers/indicators", (req, res) => {
  try {
    const { instrument, granularity, candles, params } = req.body || {};
    if (!instrument || !granularity || !Array.isArray(candles)) {
      return res.status(400).json({ error: "Bad request: missing fields" });
    }
    if (candles.length < 60) {
      return res.status(422).json({ error: "Need at least 60 candles" });
    }

    const closes = candles.map(c => parseFloat(c.mid.c));
    const highs  = candles.map(c => parseFloat(c.mid.h));
    const lows   = candles.map(c => parseFloat(c.mid.l));

    // 最低限：EMA20/50, SMA200, 直近値を返す（必要に応じてMACD/RSI等を追加）
    const ema20 = ema(closes, (params?.ema?.includes(20) ? 20 : 20));
    const ema50 = ema(closes, (params?.ema?.includes(50) ? 50 : 50));
    const sma200 = sma(closes, 200); // 本数不足なら末尾はnull

    const lastIdx = closes.length - 1;
    const resp = {
      instrument,
      granularity,
      last: {
        time: candles[lastIdx].time,
        close: closes[lastIdx],
        ema20: ema20[lastIdx],
        ema50: ema50[lastIdx],
        sma200: sma200[lastIdx] ?? null
      }
    };
    return res.json(resp);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
});

export default app;
