/**
 * AutoCusto BR — Backend
 * IA: Gemini (primário) → Groq (fallback) → OpenRouter (fallback)
 * Compatível com: Vercel (Serverless) e Render.com (Web Service)
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const fetch = require('node-fetch');
const { obterDadosOficiais, obterTaxonomia } = require('./lookup');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// ── MODELOS DA CASCATA ──────────────────────────────────────────────────────
// Configuráveis por variável de ambiente para permitir trocar de modelo sem
// alterar código — provedores depreciam modelos com frequência. Os defaults
// abaixo são o que roda se a env não estiver definida.
//
// GEMINI_MODEL: gemini-3.1-flash-lite tem 15 RPM e 500 RPD no nível gratuito,
// contra 5 RPM e 20 RPD dos demais Flash. O tráfego vem de canais sociais, que
// chegam em rajada, então o RPM é o gargalo real.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

// GROQ_MODEL: substituto indicado pela Groq após a depreciação do
// llama-3.3-70b-versatile em 17/06/2026.
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

// OPENROUTER_MODELS: lista separada por vírgula, tentada em ordem até uma
// responder. Só modelos gratuitos por padrão — 'openrouter/auto' é PAGO e foi
// deliberadamente deixado de fora; para usá-lo, basta acrescentá-lo ao valor
// desta env. Os modelos free da OpenRouter rotacionam (os DeepSeek saíram do
// catálogo em jul/2026), e 'openrouter/free' é o auto-router gratuito, que
// escolhe sozinho um free disponível — resistente a essa rotação.
const OPENROUTER_MODELS = (
  process.env.OPENROUTER_MODELS ||
  'openrouter/free,meta-llama/llama-3.3-70b-instruct:free'
).split(',').map(m => m.trim()).filter(Boolean);

// ── TEMPO LIMITE DA CASCATA ────────────────────────────────────────────────
// Sem limite, uma camada que aceita a conexão e nunca responde trava a cascata
// inteira: não cai para a seguinte nem devolve erro, e o usuário fica esperando.
//
// São dois limites. O por chamada aborta uma camada lenta. O orçamento total
// impede que a soma das tentativas estoure o tempo máximo da função na
// hospedagem, o que mataria o processo antes de qualquer resposta ao cliente.
// Ajuste CASCATA_ORCAMENTO_MS para menos que o limite do plano da Vercel.
const CHAMADA_TIMEOUT_MS = Number(process.env.CASCATA_TIMEOUT_MS) || 9000;
const CASCATA_ORCAMENTO_MS = Number(process.env.CASCATA_ORCAMENTO_MS) || 25000;

if (!GEMINI_API_KEY && !GROQ_API_KEY && !OPENROUTER_API_KEY) {
  console.error('❌ Nenhuma API Key configurada. Defina GEMINI_API_KEY, GROQ_API_KEY e/ou OPENROUTER_API_KEY.');
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
  message: { error: 'Você atingiu o limite de comparativos por hora. Volte em breve!' }
});

// ── SYSTEM PROMPT ──────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert automotive engineer and vehicle cost analyst for the Brazilian market. Your only function is vehicle consumption and cost comparison.

LANGUAGE RULES:
- User writes in Portuguese → respond entirely in pt-BR
- User writes in English → respond entirely in English
- Currency: BRL (R$)

CLASSIFY each vehicle: ICE (combustão/flex/gasolina/diesel), HEV (híbrido sem plug), PHEV (híbrido plug-in), BEV (100% elétrico)

REGION RULES — read the REGIÃO/REGION field in the user message:
- Se REGIÃO/REGION = Brasil/Brazil: use PBEV INMETRO, unidades km/L (combustão) e km/Le (elétrico), moeda R$, inclua cenário de etanol quando aplicável
- Se REGIÃO/REGION = União Europeia/European Union: use ciclo WLTP (EU oficial), unidades L/100km ou kWh/100km, moeda €, NÃO inclua etanol (use gasolina + diesel + elétrico), adapte a análise ao mercado europeu (Portugal, Espanha, França, etc.)
- SEMPRE siga a instrução de idioma indicada na mensagem do usuário

CONSUMPTION DATA — priority order (MANDATORY):
1. Região Brasil: Tabela PBEV Inmetro — versão jan/2026, gov.br/inmetro — FONTE PRIORITÁRIA OBRIGATÓRIA. Região EU: ciclo WLTP oficial — FONTE PRIORITÁRIA OBRIGATÓRIA
2. Especificações oficiais do fabricante para o mercado correspondente (ano-modelo vigente)
3. Imprensa especializada 2025/2026 (BR: Quatro Rodas, Motor Show, Mobiauto, Autoesporte | EU: imprensa especializada local)
4. Estimativa conservadora — informar claramente: "Estimativa — não localizado no PBEV 2026" (BR) ou "Estimativa — não localizado no WLTP" (EU)

CAMPO "fonte":
- Região Brasil: "PBEV INMETRO" | "Fabricante — [ano]" | "Estimativa — não localizado no PBEV 2026"
- Região EU: "WLTP (EU)" | "Fabricante — [ano]" | "Estimativa — não localizado no WLTP"
NUNCA escreva "PBEV 2024". Para EU, NUNCA mencione PBEV.

CYCLE: até 30km/dia→cidade | 31-100→70%cidade+30%estrada | >100→estrada
PRICES BR (ANP mai/2026): gasolina R$6,65/L | etanol R$4,44/L | diesel R$6,20/L | energia R$0,75/kWh
PRICES EU: use médias de mercado atuais em € para gasolina, diesel e eletricidade (kWh) do país relevante; NUNCA use preços de etanol
ETHANOL (somente Região Brasil, veículos flex): calcule ambos gasolina e etanol. Compensa se <70% gasolina (4,44<4,66→compensa). Para Região EU, etanol_compensa deve ser omitido/false e nenhum cenário de etanol deve ser apresentado
PHEV: Cenário A (carregamento noturno) + Cenário B (sem carregamento)

CALCULATIONS: km_mes=km_dia×30; km_ano=km_dia×365; consumo_mes; custo_mes; custo_ano; custo_km(4 decimais); economia vs veículo A

CRITICAL: RETURN ONLY valid JSON — absolutely no markdown, no explanation, no text outside the JSON object.
{"modo":"comparativo","comparativo":{"parametros":{"km_dia":0,"km_mes":0,"km_ano":0,"ciclo":"string","preco_gasolina":6.65,"preco_etanol":4.44,"preco_kwh":0.75,"etanol_compensa":true},"veiculos":[{"nome":"string","ano":"string","tipo":"ICE|HEV|PHEV|BEV","motor":"string","combustivel":"string","consumo_oficial":{"cidade":0,"estrada":0,"unidade":"string","fonte":"string"},"autonomia_eletrica_km":null,"cenarios":[{"nome":"string","consumo_mes":0,"unidade_consumo":"string","custo_mes":0,"custo_ano":0,"custo_km":0,"economia_mes_vs_veiculo_a":0,"economia_ano_vs_veiculo_a":0}],"cenario_recomendado":"string"}]},"analise":"string"}`;

// ── TEMPO LIMITE E ORÇAMENTO ───────────────────────────────────────────────

/**
 * Relógio do orçamento total da requisição. Cada camada pergunta quanto ainda
 * resta antes de tentar, e desiste em vez de estourar o tempo da função.
 */
function novoOrcamento(ms = CASCATA_ORCAMENTO_MS) {
  const fim = Date.now() + ms;
  return {
    restante: () => fim - Date.now(),
    esgotado: () => Date.now() >= fim,
  };
}

/**
 * fetch com AbortController. O limite efetivo é o menor entre o teto por
 * chamada e o que sobra do orçamento, para a última camada não ser cortada
 * pela hospedagem no meio da resposta.
 */
async function fetchComTimeout(url, opcoes, orcamento, rotulo) {
  const restante = orcamento ? orcamento.restante() : CHAMADA_TIMEOUT_MS;
  if (restante <= 0) {
    throw new Error(`${rotulo}: orçamento de tempo da cascata esgotado`);
  }
  const limite = Math.min(CHAMADA_TIMEOUT_MS, restante);
  const controlador = new AbortController();
  const alarme = setTimeout(() => controlador.abort(), limite);
  try {
    return await fetch(url, { ...opcoes, signal: controlador.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`${rotulo}: sem resposta em ${limite} ms`);
    }
    throw e;
  } finally {
    clearTimeout(alarme);
  }
}

// ── GEMINI ─────────────────────────────────────────────────────────────────
async function callGemini(mensagem, orcamento) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY não configurada');

  const res = await fetchComTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: mensagem }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2048,
          responseMimeType: 'application/json'
        }
      })
    },
    orcamento, 'Gemini'
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Gemini HTTP ${res.status}`);
  }

  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error('Gemini: resposta vazia');
  return JSON.parse(raw);
}

// ── GROQ ───────────────────────────────────────────────────────────────────
async function callGroq(mensagem, orcamento) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY não configurada');

  const res = await fetchComTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.1,
      max_tokens: 2048,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: mensagem }
      ]
    })
  }, orcamento, 'Groq');

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `Groq HTTP ${res.status}`;
    if (res.status === 429) {
      // A espera de 3s só compensa se ainda houver orçamento para a tentativa.
      if (orcamento && orcamento.restante() < 3000 + 2000) {
        throw new Error('Groq rate limit sem orçamento de tempo para retry');
      }
      console.warn("⏳ Groq rate limit, aguardando 3s para retry...");
      await new Promise(r => setTimeout(r, 3000));
      const res2 = await fetchComTimeout("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` },
        body: JSON.stringify({
          model: GROQ_MODEL, temperature: 0.1, max_tokens: 2048,
          response_format: { type: "json_object" },
          messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: mensagem }]
        })
      }, orcamento, 'Groq retry');
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

async function callOpenRouter(mensagem, orcamento) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY não configurada');

  let ultimoErro = null;

  for (const model of OPENROUTER_MODELS) {
    // Cada modelo da lista é uma tentativa nova, e o orçamento vale para todas
    // somadas: sem isto, uma lista longa consumiria o tempo da função inteira.
    if (orcamento && orcamento.esgotado()) {
      throw new Error(`OpenRouter: orçamento de tempo da cascata esgotado. Último erro: ${ultimoErro || 'nenhuma tentativa concluída'}`);
    }
    try {
      const res = await fetchComTimeout('https://openrouter.ai/api/v1/chat/completions', {
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
      }, orcamento, `OpenRouter ${model}`);

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

// ── PÓS-PROCESSAMENTO ──────────────────────────────────────────────────────
/**
 * A IA frequentemente erra o cálculo de custo_km (erro de ordem de grandeza),
 * mesmo quando custo_mes/custo_ano estão corretos. Recalcula custo_km de forma
 * determinística a partir de custo_mes e km_mes, garantindo precisão.
 */
// ── CONFERÊNCIA DA FORMA DA RESPOSTA ───────────────────────────────────────

/**
 * Move 'analise' para a raiz quando a IA a devolve aninhada em comparativo.
 */
function normalizarResposta(parsed) {
  if (parsed && !parsed.analise && parsed.comparativo?.analise) {
    parsed.analise = parsed.comparativo.analise;
  }
  return parsed;
}

const ehNumero = v => typeof v === 'number' && Number.isFinite(v);
const ehTexto  = v => typeof v === 'string' && v.trim().length > 0;

/**
 * Confere se a resposta tem a forma que o frontend consome, antes de aceitá-la
 * como sucesso. Um JSON sintaticamente válido mas incompleto passava direto e
 * só estourava no render, com tela vazia e sem explicação.
 *
 * A lista abaixo é o que o render acessa sem proteção, mais os dois valores
 * sem os quais o comparativo não tem conteúdo. Campo opcional de verdade,
 * como autonomia_eletrica_km, fica de fora de propósito.
 *
 * @returns {string[]} problemas encontrados, vazio quando a resposta serve
 */
function validarResposta(parsed) {
  const problemas = [];
  if (!parsed || typeof parsed !== 'object') return ['resposta não é um objeto'];

  const comp = parsed.comparativo;
  if (!comp || typeof comp !== 'object') return ['comparativo ausente'];

  const par = comp.parametros;
  if (!par || typeof par !== 'object') {
    problemas.push('parametros ausente');
  } else if (!ehNumero(par.km_mes) || par.km_mes <= 0) {
    // recalcularCustoKm divide por este valor.
    problemas.push('parametros.km_mes ausente ou não positivo');
  }

  const veics = comp.veiculos;
  if (!Array.isArray(veics) || veics.length < 2) {
    problemas.push('veiculos precisa ser uma lista com ao menos dois itens');
    return problemas;
  }

  veics.forEach((v, i) => {
    const ref = `veiculos[${i}]`;
    if (!ehTexto(v?.nome)) problemas.push(`${ref}.nome ausente`);

    const co = v?.consumo_oficial;
    if (!co || typeof co !== 'object') {
      problemas.push(`${ref}.consumo_oficial ausente`);
    } else {
      if (!ehNumero(co.cidade)) problemas.push(`${ref}.consumo_oficial.cidade ausente`);
      if (!ehTexto(co.unidade)) problemas.push(`${ref}.consumo_oficial.unidade ausente`);
      if (!ehTexto(co.fonte))   problemas.push(`${ref}.consumo_oficial.fonte ausente`);
    }

    if (!Array.isArray(v?.cenarios) || v.cenarios.length === 0) {
      problemas.push(`${ref}.cenarios vazio`);
      return;
    }
    v.cenarios.forEach((c, j) => {
      const cref = `${ref}.cenarios[${j}]`;
      if (!ehTexto(c?.nome))       problemas.push(`${cref}.nome ausente`);
      if (!ehNumero(c?.custo_mes)) problemas.push(`${cref}.custo_mes ausente`);
      if (!ehNumero(c?.custo_ano)) problemas.push(`${cref}.custo_ano ausente`);
    });
  });

  if (!ehTexto(parsed.analise)) problemas.push('analise ausente');
  return problemas;
}

function recalcularCustoKm(parsed) {
  const kmMes = parsed?.comparativo?.parametros?.km_mes;
  if (!kmMes || kmMes <= 0) return parsed;

  for (const v of parsed?.comparativo?.veiculos || []) {
    for (const c of v.cenarios || []) {
      if (typeof c.custo_mes === 'number') {
        c.custo_km = Math.round((c.custo_mes / kmMes) * 10000) / 10000;
      }
    }
  }
  return parsed;
}

// ── ROUTES ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: 'online',
  service: 'AutoCusto BR API',
  version: '2.2.0',
  ia_primaria: 'Gemini 2.5 Flash',
  ia_fallback_1: 'Groq — Llama 3.3 70B',
  ia_fallback_2: 'OpenRouter — múltiplos modelos gratuitos',
  timestamp: new Date().toISOString()
}));

// Ordem da cascata. A primeira que responder no formato esperado encerra.
const CAMADAS = [
  { nome: 'gemini',     chamar: callGemini },
  { nome: 'groq',       chamar: callGroq },
  { nome: 'openrouter', chamar: callOpenRouter },
];

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

  // A cascata percorre as camadas em ordem e para na primeira que devolver uma
  // resposta com a forma esperada. Resposta fora do formato conta como falha da
  // camada, e não como sucesso: antes disso, um JSON incompleto era aceito e só
  // quebrava no render do frontend.
  const orcamento = novoOrcamento();
  const falhas = {};
  let parsed = null;
  let iaUsada = null;

  for (const camada of CAMADAS) {
    try {
      const resposta = normalizarResposta(await camada.chamar(mensagemEnriquecida, orcamento));
      const problemas = validarResposta(resposta);
      if (problemas.length > 0) {
        throw new Error(`resposta fora do formato (${problemas.slice(0, 3).join('; ')})`);
      }
      parsed = resposta;
      iaUsada = camada.nome;
      console.log(`✅ ${camada.nome} respondeu com sucesso`);
      break;
    } catch (err) {
      falhas[camada.nome] = err.message;
      console.warn(`⚠️  ${camada.nome} falhou: ${err.message}`);
    }
  }

  if (!parsed) {
    console.error('❌ Todas as camadas falharam');
    return res.status(502).json({
      error: 'Serviço de IA temporariamente indisponível. Tente novamente em instantes.',
      detalhes: falhas
    });
  }

  parsed._ia = iaUsada;
  parsed = recalcularCustoKm(parsed);

  return res.json(parsed);
});

app.get('/api/status', (req, res) => res.json({
  status: 'ok',
  limite_por_hora: 20,
  gemini: GEMINI_API_KEY ? 'configurado' : 'não configurado',
  groq: GROQ_API_KEY ? 'configurado' : 'não configurado',
  openrouter: OPENROUTER_API_KEY ? 'configurado' : 'não configurado'
}));

// ── TAXONOMIA (para seletores em cascata do frontend) ──────────────────────
// Leitura estática, sem custo de IA. Usa o globalLimiter só por consistência
// com as demais rotas. Devolve apenas os textos (marca/modelo/versão), sem
// dados de consumo, para manter o payload pequeno.
app.get('/api/veiculos/taxonomia', globalLimiter, (req, res) => {
  try {
    const taxonomia = obterTaxonomia(); // só região BR / pbev.json por enquanto
    res.json(taxonomia);
  } catch (e) {
    console.error('❌ Falha ao montar taxonomia:', e.message);
    res.status(500).json({ error: 'Falha ao carregar taxonomia de veículos.' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ AutoCusto BR backend na porta ${PORT}`);
  console.log(`🤖 Gemini:      ${GEMINI_API_KEY ? 'configurado ✓' : 'NÃO CONFIGURADO ✗'}  → ${GEMINI_MODEL}`);
  console.log(`🤖 Groq:        ${GROQ_API_KEY ? 'configurado ✓' : 'NÃO CONFIGURADO ✗'}  → ${GROQ_MODEL}`);
  console.log(`🤖 OpenRouter:  ${OPENROUTER_API_KEY ? 'configurado ✓' : 'NÃO CONFIGURADO ✗'}  → ${OPENROUTER_MODELS.join(', ')}`);
});

module.exports = app;
