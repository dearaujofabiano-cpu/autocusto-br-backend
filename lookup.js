/**
 * AutoCusto BR — Lookup de dados oficiais
 * Busca veículo em pbev.json antes de enviar o prompt para a IA.
 *
 * O app cobria também a União Europeia, com wltp.json. A região foi retirada
 * em 23/09/2026, junto com esse conjunto de dados: a fonte era a VCA, agência
 * do Reino Unido, e não da UE, e não se achou base europeia com a estrutura de
 * marca, modelo e versão que os seletores em cascata exigem.
 */

const path = require('path');
const fs   = require('fs');

let _pbev = null;

function carregarDados() {
  if (!_pbev) {
    const p = path.join(__dirname, 'dados', 'pbev.json');
    _pbev = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : [];
  }
}

/**
 * Normaliza string para comparação: maiúsculo, sem acentos, sem hífens duplos.
 */
function norm(s) {
  if (!s) return '';
  return s
    .toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Score de similaridade entre duas strings normalizadas.
 * Retorna número entre 0 e 1 (1 = match perfeito).
 */
function score(haystack, needle) {
  const h = norm(haystack);
  const n = norm(needle);
  if (!h || !n) return 0;
  if (h === n) return 1;
  if (h.includes(n) || n.includes(h)) return 0.9;

  // Quantas palavras do needle estão no haystack
  const words = n.split(' ').filter(Boolean);
  const matches = words.filter(w => h.includes(w));
  return matches.length / words.length;
}

/**
 * Busca o veículo mais próximo no dataset dado.
 * @param {Array}  dataset  - registros do pbev.json
 * @param {string} marca
 * @param {string} modelo
 * @param {string} versao   - opcional
 * @param {number} minScore - score mínimo para aceitar (default 0.6)
 */
function buscar(dataset, marca, modelo, versao = '', minScore = 0.6) {
  let melhor = null;
  let melhorScore = 0;

  const nMarca  = norm(marca);
  const nModelo = norm(modelo);
  const nVersao = norm(versao);

  for (const v of dataset) {
    const sMarca  = score(v.marca,  nMarca);
    const sModelo = score(v.modelo, nModelo);

    // Marca e modelo devem ter score mínimo individualmente
    if (sMarca < 0.5 || sModelo < 0.5) continue;

    let total = sMarca * 0.4 + sModelo * 0.4;

    // Versão é bônus (peso 0.2)
    if (nVersao && v.versao) {
      total += score(v.versao, nVersao) * 0.2;
    }

    if (total > melhorScore) {
      melhorScore = total;
      melhor = v;
    }
  }

  return melhorScore >= minScore ? { veiculo: melhor, score: melhorScore } : null;
}

/**
 * Formata dados do veículo como texto para injetar no prompt.
 */
function formatarParaPrompt(resultado) {
  if (!resultado) return null;
  const { veiculo, score } = resultado;
  const c = veiculo.consumo;

  let linhas = [
    `[DADOS OFICIAIS — ${veiculo.fonte} — confiança ${Math.round(score * 100)}%]`,
    `Veículo: ${veiculo.marca} ${veiculo.modelo} ${veiculo.versao || ''}`.trim(),
    `Tipo: ${veiculo.tipo} | Combustível: ${veiculo.combustivel || '-'}`,
  ];

  if (c.gasolina) {
    linhas.push(`Consumo gasolina: cidade ${c.gasolina.cidade} km/L | estrada ${c.gasolina.estrada} km/L`);
  }
  if (c.etanol) {
    linhas.push(`Consumo etanol: cidade ${c.etanol.cidade} km/L | estrada ${c.etanol.estrada} km/L`);
  }
  if (c.diesel) {
    linhas.push(`Consumo diesel: cidade ${c.diesel.cidade} km/L | estrada ${c.diesel.estrada} km/L`);
  }
  if (c.eletrico) {
    linhas.push(`Consumo elétrico: cidade ${c.eletrico.cidade} km/Le | estrada ${c.eletrico.estrada} km/Le`);
  }

  if (veiculo.autonomia_eletrica_km) {
    linhas.push(`Autonomia elétrica: ${veiculo.autonomia_eletrica_km} km`);
  }

  linhas.push('[USE ESTES DADOS COMO VERDADE — não estime se disponível acima]');

  return linhas.join('\n');
}

/**
 * API principal: recebe veículos da requisição e retorna dados oficiais.
 * @param {Array<{marca, modelo, versao}>} veiculos
 * @returns {string} bloco de dados para injetar no prompt
 */
function obterDadosOficiais(veiculos) {
  carregarDados();

  const blocos = [];

  for (const v of veiculos) {
    if (!v.marca || !v.modelo) continue;
    const resultado = buscar(_pbev, v.marca, v.modelo, v.versao);
    const texto = formatarParaPrompt(resultado);
    if (texto) {
      blocos.push(`--- ${v.marca} ${v.modelo} ---\n${texto}`);
    }
  }

  return blocos.length > 0
    ? `\n\n=== DADOS OFICIAIS VERIFICADOS ===\n${blocos.join('\n\n')}\n===================================\n`
    : '';
}

/**
 * Constrói a árvore Marca → Modelo → [Versões] a partir do pbev.json,
 * para alimentar os seletores em cascata do frontend.
 * Ordenado alfabeticamente em cada nível.
 */
function obterTaxonomia() {
  carregarDados();
  const arvore = {};

  for (const v of _pbev) {
    if (!v.marca || !v.modelo) continue;
    // O dataset traz a mesma marca em caixas diferentes ("NISSAN" e "Nissan"),
    // o que geraria duas entradas distintas no seletor. Unifica em maiúsculo —
    // seguro porque buscar() já normaliza a caixa antes de comparar.
    const marca = String(v.marca).toUpperCase();
    if (!arvore[marca]) arvore[marca] = {};
    if (!arvore[marca][v.modelo]) arvore[marca][v.modelo] = new Set();
    if (v.versao) arvore[marca][v.modelo].add(v.versao);
  }

  // Converter Sets em arrays ordenados, e ordenar marcas/modelos.
  // localeCompare em vez de sort() puro: a ordenação padrão é por code unit,
  // que jogaria qualquer entrada em caixa mista para fora da ordem alfabética.
  const ord = (a, b) => a.localeCompare(b, 'pt-BR');
  const resultado = {};
  for (const marca of Object.keys(arvore).sort(ord)) {
    resultado[marca] = {};
    for (const modelo of Object.keys(arvore[marca]).sort(ord)) {
      resultado[marca][modelo] = [...arvore[marca][modelo]].sort(ord);
    }
  }
  return resultado;
}

module.exports = { obterDadosOficiais, obterTaxonomia };
