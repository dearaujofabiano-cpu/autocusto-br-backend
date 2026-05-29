/**
 * AutoCusto BR — Backend
 * Compatível com: Vercel (Serverless) e Render.com (Web Service)
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

if (!GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY não definida.');
  process.exit(1);
}

// ── CORS ───────────────────────────────────────────────────────────────────
app.use(cors({
  origin: ALLOWED_ORIGIN === '*' ? '*' : (origin, cb) => {
    if (!origin || origin === ALLOWED_ORIGIN) cb(null, true);
    else cb(new Error('CORS: origem não autorizada'));
  },
  methods: ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json({ limit: '16kb' }));

// ── RATE LIMITING ──────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 500,
  message: { error: 'Servidor sobrecarregado. Tente novamente em alguns minutos.' }
});
const perIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 10,
  keyGenerator: req => req.headers['x-forwarded-for']?.split(',')[0] || req.ip,
  message: { error: 'Você atingiu o limite de 10 comparativos por hora. Volte em breve!' }
});

// ── SYSTEM PROMPT ──────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert automotive engineer and vehicle cost analyst for the Brazilian market. Your only function is vehicle consumption and cost comparison.

LANGUAGE RULES:
- User writes in Portuguese → respond entirely in pt-BR
- User writes in English → respond entirely in English
- Currency: BRL (R$)

CLASSIFY each vehicle: ICE (combustão/flex/gasolina), HEV (híbrido sem plug), PHEV (híbrido plug-in), BEV (100% elétrico)

CONSUMPTION DATA — priority order (MANDATORY):
1. Tabela PBEV 2026 (Inmetro) — versão abril/2026, gov.br/inmetro — FONTE PRIORITÁRIA OBRIGATÓRIA
2. Especificações oficiais do fabricante para o mercado brasileiro (ano-modelo vigente)
3. Imprensa especializada brasileira 2025/2026: Quatro Rodas, Motor Show, Mobiauto, Autoesporte
4. Estimativa conservadora — informar claramente: "Estimativa — não localizado no PBEV 2026"

CAMPO "fonte": "PBEV 2026 (Inmetro)" | "Fabricante — [ano]" | "Estimativa — não localizado no PBEV 2026"
NUNCA escreva "PBEV 2024".

CYCLE: até 30km/dia→cidade | 31-100→70%cidade+30%estrada | >100→estrada
PRICES (ANP mai/2026): gasolina R$6,65/L | etanol R$4,44/L | energia R$0,75/kWh
ETHANOL: flex→calcule ambos. Compensa se <70% gasolina (4,44<4,66→compensa)
PHEV: Cenário A (carregamento noturno) + Cenário B (sem carregamento)

CALCULATIONS: km_mes=km_dia×30; km_ano=km_dia×365; consumo_mes; custo_mes; custo_ano; custo_km(4 decimais); economia vs veículo A

RETURN ONLY valid JSON — no markdown, no text outside JSON:
{"modo":"comparativo","comparativo":{"parametros":{"km_dia":0,"km_mes":0,"km_ano":0,"ciclo":"string","preco_gasolina":6.65,"preco_etanol":4.44,"preco_kwh":0.75,"etanol_compensa":true},"veiculos":[{"nome":"string","ano":"string","tipo":"ICE|HEV|PHEV|BEV","motor":"string","combustivel":"string","consumo_oficial":{"cidade":0,"estrada":0,"unidade":"string","fonte":"string"},"autonomia_eletrica_km":null,"cenarios":[{"nome":"string","consumo_mes":0,"unidade_consumo":"string","custo_mes":0,"custo_ano":0,"custo_km":0,"economia_mes_vs_veiculo_a":0,"economia_ano_vs_veiculo_a":0}],"cenario_recomendado":"string"}]},"analise":"string"}`;

// ── ROUTES ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: 'online', service: 'AutoCusto BR API', version: '1.0.0',
  timestamp: new Date().toISOString()
}));

app.post('/api/comparar', globalLimiter, perIpLimiter, async (req, res) => {
  const { mensagem } = req.body;
  if (!mensagem || typeof mensagem !== 'string' || mensagem.length > 500)
    return res.status(400).json({ error: 'Mensagem inválida.' });

  const bloqueadas = ['ignore', 'system prompt', 'jailbreak', 'forget', 'esqueça'];
  if (bloqueadas.some(t => mensagem.toLowerCase().includes(t)))
    return res.status(400).json({ error: 'Entrada inválida.' });

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: mensagem }] }],
          generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
        })
      }
    );
    if (!geminiRes.ok) {
      const err = await geminiRes.json().catch(() => ({}));
      return res.status(502).json({ error: err?.error?.message || 'Erro ao consultar a IA.' });
    }
    const data = await geminiRes.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return res.status(502).json({ error: 'Resposta vazia da IA.' });
    const parsed = JSON.parse(raw.replace(/^```json\n?/, '').replace(/\n?```$/, ''));
    return res.json(parsed);
  } catch (err) {
    console.error(err.message);
    if (err instanceof SyntaxError)
      return res.status(502).json({ error: 'Resposta inesperada da IA. Tente novamente.' });
    return res.status(500).json({ error: 'Erro interno.' });
  }
});

app.get('/api/status', (req, res) => res.json({ status: 'ok', limite_por_hora: 10 }));

app.listen(PORT, () => {
  console.log(`✅ AutoCusto BR backend na porta ${PORT}`);
  console.log(`🔑 API Key: ${GEMINI_API_KEY ? 'configurada ✓' : 'NÃO CONFIGURADA ✗'}`);
});

module.exports = app;
