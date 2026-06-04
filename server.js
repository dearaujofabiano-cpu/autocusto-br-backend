/**
 * AutoCusto BR — Backend
 * IA: Groq (primário) → OpenRouter (fallback automático)
 * Compatível com: Vercel (Serverless) e Render.com (Web Service)
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const fetch = require('node-fetch');
const { obterDadosOficiais } = require('./lookup');

const app = express();
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

if (!GROQ_API_KEY && !OPENROUTER_API_KEY) {
  console.error('❌ Nenhuma API Key configurada. Defina GROQ_API_KEY e/ou OPENROUTER_API_KEY.');
  process.exit(1);
}

// ── TRUST PROXY (obrigatório no Vercel para o rate-limit funcionar) ─────────
app.set('trust proxy', 1);

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
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Servidor sobrecarregado. Tente novamente em alguns minutos.' }
});
const perIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip,
  message: { error: 'Você atingiu o limite de comparativos por hora. Volte em breve!' }
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

CAMPO "fonte":
- Região Brasil: "PBEV 2026 (Inmetro)" | "Fabricante — [ano]" | "Estimativa — não localizado no PBEV 2026"
- Região EU: "WLTP (EU)" | "Fabricante — [ano]" | "Estimativa — não localizado no WLTP"
NUNCA escreva "PBEV 2024". Para EU, NUNCA mencione PBEV.

CYCLE: até 30km/dia→cidade | 31-100→70%cidade+30%estrada | >100→estrada
PRICES (ANP mai/2026): gasolina R$6,65/L | etanol R$4,44/L | energia R$0,75/kWh
ETHANOL: flex→calcule ambos. Compensa se <70% gasolina (4,44<4,66→compensa)
PHEV: Cenário A (carregamento noturno) + Cenário B (sem carregamento)

CALCULATIONS: km_mes=km_dia×30; km_ano=km_dia×365; consumo_mes; custo_mes; custo_ano; custo_km(4 decimais); economia vs veículo A

CRITICAL: RETURN ONLY valid JSON — absolutely no markdown, no explanation, no text outside the JSON object.
{"modo":"comparativo","comparativo":{"parametros":{"km_dia":0,"km_mes":0,"km_ano":0,"ciclo":"string","preco_gasolina":6.65,"preco_etanol":4.44,"preco_kwh":0.75,"etanol_compensa":true},"veiculos":[{"nome":"string","ano":"string","tipo":"ICE|HEV|PHEV|BEV","motor":"string","combustivel":"string","consumo_oficial":{"cidade":0,"estrada":0,"unidade":"string","fonte":"string"},"autonomia_eletrica_km":null,"cenarios":[{"nome":"string","consumo_mes":0,"unidade_consumo":"string","custo_mes":0,"custo_ano":0,"custo_km":0,"economia_mes_vs_veiculo_a":0,"economia_ano_vs_veiculo_a":0}],"cenario_recomendado":"string"}]},"analise":"string"}`;

// ── GROQ ───────────────────────────────────────────────────────────────────
async function callGroq(mensagem) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY não configurada');

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1,
      max_tokens: 2048,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: mensagem }
      ]
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `Groq HTTP ${res.status}`;
    if (res.status === 429) {
      console.warn("⏳ Groq rate limit — aguardando 3s para retry...");
      await new Promise(r => setTimeout(r, 3000));
      const res2 = await fetch("https://api.groq.com/openai/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` }, body: JSON.stringify({ model: "llama-3.3-70b-versatile", temperature: 0.1, max_tokens: 2048, response_format: { type: "json_object" }, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: mensagem }] }) });
      if (!res2.ok) throw new Error("Groq rate limit persistente — passando para fallback");
      const data2 = await res2.json();
      const raw2 = data2?.choices?.[0]?.message?.content;
      if (!raw2) throw new Error("Groq retry: resposta vazia");
      return JSON.parse(raw2);
    }
    throw new Error(msg);
  }

  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('Groq: resposta vazia');
  return JSON.parse(raw);
}

// ── OPENROUTER ─────────────────────────────────────────────────────────────
// Tenta múltiplos modelos gratuitos em sequência
const OPENROUTER_MODELS = [
  'openrouter/auto',
  'deepseek/deepseek-r1:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'deepseek/deepseek-v3:free',
];

async function callOpenRouter(mensagem) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY não configurada');

  let ultimoErro = null;

  for (const model of OPENROUTER_MODELS) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://autocusto-br.vercel.app',
          'X-Title': 'AutoCusto BR'
        },
        body: JSON.stringify({
          model,
          temperature: 0.1,
          max_tokens: 2048,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: mensagem }
          ]
        })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message || `OpenRouter HTTP ${res.status}`);
      }

      const data = await res.json();
      const raw = data?.choices?.[0]?.message?.content;
      if (!raw) throw new Error('OpenRouter: resposta vazia');

      const parsed = JSON.parse(raw.replace(/^```json\n?/, '').replace(/\n?```$/, ''));
      console.log(`✅ OpenRouter respondeu com sucesso — modelo: ${model}`);
      return parsed;

    } catch (err) {
      ultimoErro = err.message;
      console.warn(`⚠️  OpenRouter modelo ${model} falhou: ${ultimoErro}`);
    }
  }

  throw new Error(`OpenRouter: todos os modelos falharam. Último erro: ${ultimoErro}`);
}

// ── ROUTES ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: 'online',
  service: 'AutoCusto BR API',
  version: '2.1.0',
  ia_primaria: 'Groq — Llama 3.3 70B',
  ia_fallback: 'OpenRouter — múltiplos modelos gratuitos',
  timestamp: new Date().toISOString()
}));

app.post('/api/comparar', globalLimiter, perIpLimiter, async (req, res) => {
  const { mensagem } = req.body;
  if (!mensagem || typeof mensagem !== 'string' || mensagem.length > 1500)
    return res.status(400).json({ error: 'Mensagem inválida.' });

  const bloqueadas = ['ignore', 'system prompt', 'jailbreak', 'forget', 'esqueça'];
  if (bloqueadas.some(t => mensagem.toLowerCase().includes(t)))
    return res.status(400).json({ error: 'Entrada inválida.' });

  // ── Enriquecer prompt com dados oficiais ──────────────────────────────
  const { veiculos, regiao } = req.body;
  let mensagemEnriquecida = mensagem;
  try {
    if (Array.isArray(veiculos) && veiculos.length > 0) {
      const dadosOficiais = obterDadosOficiais(veiculos, regiao || 'BR');
      if (dadosOficiais) {
        mensagemEnriquecida = mensagem + dadosOficiais;
        console.log(`📋 Dados oficiais injetados para ${veiculos.length} veículo(s)`);
      }
    }
  } catch (e) {
    console.warn('⚠️  Lookup falhou (usando apenas IA):', e.message);
  }

  let parsed = null;
  let iaUsada = null;
  let erroGroq = null;

  // 1. Tenta Groq
  try {
    parsed = await callGroq(mensagemEnriquecida);
    iaUsada = 'groq';
    console.log('✅ Groq respondeu com sucesso');
  } catch (err) {
    erroGroq = err.message;
    console.warn(`⚠️  Groq falhou (${erroGroq}) — tentando OpenRouter...`);

    // 2. Fallback: OpenRouter (tenta múltiplos modelos internamente)
    try {
      parsed = await callOpenRouter(mensagemEnriquecida);
      iaUsada = 'openrouter';
    } catch (err2) {
      console.error(`❌ OpenRouter também falhou: ${err2.message}`);
      return res.status(502).json({
        error: 'Serviço de IA temporariamente indisponível. Tente novamente em instantes.',
        detalhes: { groq: erroGroq, openrouter: err2.message }
      });
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return res.status(502).json({ error: 'Resposta inesperada da IA. Tente novamente.' });
  }

  parsed._ia = iaUsada;

  // Normalização: garante que 'analise' sempre esteja na raiz do objeto
  if (!parsed.analise && parsed.comparativo?.analise) {
    parsed.analise = parsed.comparativo.analise;
  }

  return res.json(parsed);
});

app.get('/api/status', (req, res) => res.json({
  status: 'ok',
  limite_por_hora: 20,
  groq: GROQ_API_KEY ? 'configurado' : 'não configurado',
  openrouter: OPENROUTER_API_KEY ? 'configurado' : 'não configurado'
}));

app.listen(PORT, () => {
  console.log(`✅ AutoCusto BR backend na porta ${PORT}`);
  console.log(`🤖 Groq:        ${GROQ_API_KEY ? 'configurado ✓' : 'NÃO CONFIGURADO ✗'}`);
  console.log(`🤖 OpenRouter:  ${OPENROUTER_API_KEY ? 'configurado ✓' : 'NÃO CONFIGURADO ✗'}`);
});

module.exports = app;
