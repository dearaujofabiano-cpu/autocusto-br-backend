/**
 * AutoCusto BR — Lookup de dados oficiais
 * Busca veículo em pbev.json (BR) ou wltp.json (EU)
 * antes de enviar o prompt para a IA.
 */

const path = require('path');
const fs   = require('fs');

let _pbev = null;
let _wltp = null;

function carregarDados() {
  if (!_pbev) {
    const p = path.join(__dirname, 'dados', 'pbev.json');
    _pbev = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : [];
  }
  if (!_wltp) {
    const p = path.join(__dirname, 'dados', 'wltp.json');
    _wltp = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : [];
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
 * @param {Array}  dataset  - pbev ou wltp
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
function formatarParaPrompt(resultado, regiao) {
  if (!resultado) return null;
  const { veiculo, score } = resultado;
  const c = veiculo.consumo;

  let linhas = [
    `[DADOS OFICIAIS — ${veiculo.fonte} — confiança ${Math.round(score * 100)}%]`,
    `Veículo: ${veiculo.marca} ${veiculo.modelo} ${veiculo.versao || ''}`.trim(),
    `Tipo: ${veiculo.tipo} | Combustível: ${veiculo.combustivel || '-'}`,
  ];

  if (regiao === 'BR') {
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
  } else {
    // EU — WLTP em L/100km ou Wh/km
    if (c.combinado) {
      linhas.push(`Consumo WLTP combinado: ${c.combinado.valor} ${c.combinado.unidade}`);
    }
    if (c.gasolina_combinado) {
      linhas.push(`Consumo WLTP gasolina combinado: ${c.gasolina_combinado.valor} ${c.gasolina_combinado.unidade}`);
    }
    if (c.eletrico_wh_km) {
      linhas.push(`Consumo elétrico: ${c.eletrico_wh_km.valor} ${c.eletrico_wh_km.unidade}`);
    }
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
 * @param {string} regiao - 'BR' ou 'EU'
 * @returns {string} bloco de dados para injetar no prompt
 */
function obterDadosOficiais(veiculos, regiao = 'BR') {
  carregarDados();
  const dataset = regiao === 'EU' ? _wltp : _pbev;

  const blocos = [];

  for (const v of veiculos) {
    if (!v.marca || !v.modelo) continue;
    const resultado = buscar(dataset, v.marca, v.modelo, v.versao);
    const texto = formatarParaPrompt(resultado, regiao);
    if (texto) {
      blocos.push(`--- ${v.marca} ${v.modelo} ---\n${texto}`);
    }
  }

  return blocos.length > 0
    ? `\n\n=== DADOS OFICIAIS VERIFICADOS ===\n${blocos.join('\n\n')}\n===================================\n`
    : '';
}

module.exports = { obterDadosOficiais };
