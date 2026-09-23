#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gerar_dados.py, regenera os JSONs de dados oficiais do AutoCusto BR.

    pip install pdfplumber pandas
    python gerar_dados.py --pbev "Tabela PBEV 2026_20_JAN-REV04.pdf" \
                          --wltp Euro_6_latest.csv \
                          --out ./dados

Cada fonte e opcional: passe so --pbev para regerar o Brasil, so --wltp para
regerar a Uniao Europeia, ou os dois.

FONTES
  Brasil: PDF do PBEV, Inmetro, gov.br/inmetro. Publicado com revisoes ao
          longo do ano (JAN-REV04, JUN, AGO...). Use sempre a mais recente.
  UE:     CSV Euro 6 da VCA, carfueldata.vehicle-certification-agency.gov.uk.
          Publicado uma vez por ano.

POR QUE pdfplumber E NAO pypdf
  O pypdf embaralha as colunas da tabela do Inmetro, o que gera consumo
  trocado entre gasolina e etanol. O pdfplumber preserva a grade.

LAYOUTS SUPORTADOS
  O Inmetro mudou a tabela entre as revisoes de 2026. O script detecta pela
  largura, ver LAYOUTS, e aceita as duas que circulam:
    28 colunas (revisao de janeiro): uma linha e um veiculo.
    33 colunas (revisao de agosto):  uma linha traz ate 4 veiculos
                                     empilhados dentro das celulas.
  Revisao com outra largura para o script; nunca grava dado adivinhado.
"""

import argparse
import json
import re
from collections import Counter
from pathlib import Path


# ══════════════════════════════════════════════════════════════════════════
#  BRASIL, PBEV Inmetro
# ══════════════════════════════════════════════════════════════════════════

TIPO_MAP = {
    'Combustão': 'ICE',  'Combustao': 'ICE',
    'Híbrido':   'HEV',  'Hibrido':   'HEV',
    'Plug-in':   'PHEV', 'Plug-In':   'PHEV',
    'Elétrico':  'BEV',  'Eletrico':  'BEV',
}
# E100 apareceu na revisao de agosto de 2026, nas versoes ALC do Onix, que
# rodam so com etanol e nao trazem coluna de gasolina.
COMB_MAP = {'E': 'Etanol', 'E100': 'Etanol', 'G': 'Gasolina',
            'F': 'Flex', 'D': 'Diesel'}


def _num(s):
    """Numero da celula do PDF. Vazio, barra, ND e traco viram None."""
    s = (s or '').strip()
    if not s or s in ('\\', 'ND', '-'):
        return None
    try:
        return float(s.replace(',', '.'))
    except ValueError:
        return None


def _txt(s):
    return ' '.join((s or '').split())


COMB_VALIDOS = {'Etanol', 'Gasolina', 'Flex', 'Diesel', 'Elétrico'}
TIPOS_VALIDOS = {'ICE', 'HEV', 'PHEV', 'BEV'}


def _conferir_sanidade_pbev(registros, pdf_path):
    """
    Barra a gravacao quando a extracao saiu embaralhada.

    Ultima rede de protecao, depois da deteccao de layout e do filtro por
    vocabulario fechado. Medido em 23/09/2026: ler o PDF de agosto com a
    grade de janeiro devolvia marca duplicada e modelo trocado ('AUDI AUDI
    SQ6 Sportback e-tron Quattro Q7 - S Line') e metade dos registros.

    Sem esta conferencia, esse lixo era gravado por cima de dados/pbev.json
    sem um aviso sequer, o que e pior do que nao ter script nenhum: o app
    passaria a comparar veiculos com consumo de outro carro.
    """
    problemas = []

    combs = Counter(e['combustivel'] for e in registros)
    invalidos = {c: n for c, n in combs.items() if c not in COMB_VALIDOS}
    if invalidos:
        problemas.append('combustiveis fora do esperado: %r' % invalidos)

    tipos = Counter(e['tipo'] for e in registros)
    tipos_inv = {t: n for t, n in tipos.items() if t not in TIPOS_VALIDOS}
    if tipos_inv:
        problemas.append('tipos fora do esperado: %r' % tipos_inv)

    # Coluna deslocada faz a marca virar 'AUDI AUDI' ou 'CHEVROLET FIAT'.
    repetidos = [e for e in registros
                 if len(e['marca'].split()) > 1
                 and len(set(e['marca'].upper().split())) < len(e['marca'].split())]
    if repetidos:
        problemas.append('%d registros com marca repetida, ex: %r'
                         % (len(repetidos), repetidos[0]['marca']))

    vazios = [e for e in registros if not e['consumo']]
    if registros and len(vazios) / len(registros) > 0.02:
        problemas.append('%d de %d registros sem consumo nenhum'
                         % (len(vazios), len(registros)))

    if problemas:
        raise SystemExit(
            'ERRO: a extracao de %s saiu embaralhada, NADA foi gravado.\n' % pdf_path
            + ''.join('  - %s\n' % p for p in problemas)
            + '\nO layout deste PDF nao bate com nenhum dos suportados.\n'
              'Inspecione a tabela real antes de ajustar:\n'
              '  import pdfplumber\n'
              '  with pdfplumber.open(PDF) as pdf:\n'
              '      for t in pdf.pages[3].extract_tables():\n'
              '          print(len(t[0]), t[0]); print(t[1])\n'
              'Depois acrescente a largura e os indices em LAYOUTS.\n'
        )


def _partes(celula, n):
    """
    Uma celula do layout de 33 colunas guarda N veiculos empilhados, separados
    por quebra de linha. Devolve as N partes, ou uma lista de None quando a
    celula esta vazia (linha de eletrico nao tem coluna de gasolina). Devolve
    False quando a contagem nao bate, sinal de linha corrompida.
    """
    if celula is None or not str(celula).strip():
        return [None] * n
    partes = str(celula).split('\n')
    if len(partes) == n:
        return partes
    return False


# Texto sobreposto vira letra repetida: 'HHHH YYYY UUUU NNNN DDDD AAAA IIII'.
LIXO_SOBREPOSTO = re.compile(r'(.)\1{3,}')


def _colunas_usadas(idx):
    """Indices que gerar_pbev() de fato le. Uma coluna que o script ignora
    nao pode derrubar a linha inteira so por vir mal formada."""
    usadas = {0, 1, 2, 3, 4, 5, 6, 9, idx['autonomia']}
    for par in ('etanol', 'fossil', 'eletrico'):
        usadas.update(idx[par])
    usadas.update(range(*idx['emissoes'].indices(10 ** 6)))
    return sorted(usadas)


def _expandir(linhas, largura, idx):
    """
    Layout de 28 colunas (PDF de janeiro): uma linha e um veiculo.
    Layout de 33 colunas (PDF de agosto): uma linha traz de 1 a 4 veiculos
    empilhados dentro das celulas, separados por quebra de linha. Foi essa
    mudanca que fez o extrator antigo devolver marca duplicada e consumo de
    outro carro, e nao apenas o deslocamento dos indices.
    """
    if largura == 28:
        return [list(r) for r in linhas], 0

    usadas = _colunas_usadas(idx)
    registros, descartadas = [], 0
    for r in linhas:
        marca = r[1]
        if marca is None:
            descartadas += 1
            continue
        # Algumas linhas saem com o texto desenhado varias vezes uma sobre a
        # outra. dedupe_chars nao resolve, porque nao sao duplicatas de mesma
        # posicao. A checagem pela marca so pega sobreposicao de 3 copias ou
        # mais; a de 2 copias ('CCoommbbuusstt') cai no filtro por vocabulario
        # fechado de 'tipo', em gerar_pbev().
        if LIXO_SOBREPOSTO.search(str(marca)):
            descartadas += 1
            continue
        n = len(str(marca).split('\n'))
        colunas = [_partes(c, n) for c in r]
        # So as colunas lidas precisam bater. Exigir isso das 33 derrubava
        # linhas inteiras por causa de coluna que nem entra no JSON: medido em
        # 23/09/2026, 24 linhas descartadas contra 2 realmente ilegiveis.
        if any(colunas[j] is False for j in usadas):
            descartadas += 1
            continue
        colunas = [c if c is not False else [None] * n for c in colunas]
        for i in range(n):
            registros.append([c[i] for c in colunas])
    return registros, descartadas


# Indice de cada campo por largura de tabela. O Inmetro mudou o layout entre a
# revisao de janeiro e a de agosto de 2026, e as duas circulam, entao o script
# detecta pela largura em vez de assumir uma.
# Opcoes de extracao. Com o padrao do pdfplumber, o PDF de agosto devolvia
# 481 linhas com ate 4 veiculos empilhados por celula e 20 linhas com o texto
# desenhado umas sobre as outras, ilegiveis. Com a grade de linhas e
# snap_tolerance 1, o mesmo PDF devolve 968 linhas, uma por veiculo, e
# nenhuma corrompida. Medido em 23/09/2026:
#   padrao          481 linhas, 20 corrompidas, 856 veiculos
#   lines+snap=1    968 linhas,  0 corrompidas, 968 veiculos
# O desdobramento por quebra de linha continua no codigo porque nao custa
# nada e cobre revisao futura que volte a empilhar.
EXTRACAO = {
    'vertical_strategy': 'lines',
    'horizontal_strategy': 'lines',
    'snap_tolerance': 1,
}

LAYOUTS = {
    28: {'etanol': (17, 18), 'fossil': (19, 20), 'eletrico': (21, 22),
         'autonomia': 24, 'emissoes': slice(10, 16)},
    33: {'etanol': (18, 19), 'fossil': (21, 22), 'eletrico': (24, 25),
         'autonomia': 29, 'emissoes': slice(10, 14)},
}


def gerar_pbev(pdf_path):
    import pdfplumber

    por_largura = {}
    with pdfplumber.open(pdf_path) as pdf:
        for pagina in pdf.pages:
            for tabela in pagina.extract_tables(EXTRACAO):
                for linha in tabela:
                    if not linha or linha[0] in ('Categoria', None):
                        continue
                    if len(linha) in LAYOUTS:
                        por_largura.setdefault(len(linha), []).append(linha)

    if not por_largura:
        raise SystemExit(
            'ERRO: nenhuma tabela reconhecida em %s.\n'
            'Larguras suportadas: %s. Inspecione o PDF com:\n'
            '  import pdfplumber\n'
            '  with pdfplumber.open(PDF) as pdf:\n'
            '      for t in pdf.pages[0].extract_tables(): print(len(t[0]))'
            % (pdf_path, sorted(LAYOUTS))
        )

    largura = max(por_largura, key=lambda k: len(por_largura[k]))
    brutas = [r for r in por_largura[largura]
              if r[1] is not None and str(r[1]).strip() and 'Marca' not in str(r[1])]
    idx = LAYOUTS[largura]
    print('  layout detectado: %d colunas, %d linhas de tabela' % (largura, len(brutas)))

    linhas, descartadas = _expandir(brutas, largura, idx)
    if descartadas:
        proporcao = descartadas / len(brutas)
        print('  %d linhas descartadas por texto corrompido (%.1f%%)'
              % (descartadas, proporcao * 100))
        if proporcao > 0.05:
            raise SystemExit(
                'ERRO: %.1f%% das linhas sairam corrompidas, alto demais para\n'
                'ignorar. A extracao deste PDF nao esta confiavel, nada foi gravado.'
                % (proporcao * 100)
            )

    registros = []
    corrompidos = 0
    for r in linhas:
        # 'tipo' e 'combustivel' tem vocabulario fechado, entao servem de
        # peneira confiavel contra texto sobreposto: 'CCoommbbuusstt\u00e3\u00e3oo' e
        # 'FF' nao passam, e nenhum valor legitimo e barrado por engano.
        tipo = TIPO_MAP.get((r[5] or '').strip())
        if tipo is None:
            corrompidos += 1
            continue
        if tipo == 'BEV':
            combustivel = 'El\u00e9trico'
        else:
            combustivel = COMB_MAP.get((r[9] or '').strip())
            if combustivel is None:
                corrompidos += 1
                continue

        etanol = (_num(r[idx['etanol'][0]]), _num(r[idx['etanol'][1]]))
        fossil = (_num(r[idx['fossil'][0]]), _num(r[idx['fossil'][1]]))
        eletrico = (_num(r[idx['eletrico'][0]]), _num(r[idx['eletrico'][1]]))
        autonomia = _num(r[idx['autonomia']])

        consumo = {}
        if None not in etanol:
            consumo['etanol'] = {'cidade': etanol[0], 'estrada': etanol[1], 'unidade': 'km/L'}
        if None not in fossil:
            chave = 'diesel' if combustivel == 'Diesel' else 'gasolina'
            consumo[chave] = {'cidade': fossil[0], 'estrada': fossil[1], 'unidade': 'km/L'}
        if None not in eletrico:
            # km/Le, quilometro por litro equivalente, como o Inmetro publica.
            consumo['eletrico'] = {'cidade': eletrico[0], 'estrada': eletrico[1], 'unidade': 'km/Le'}

        entrada = {
            'fonte': 'PBEV Inmetro',
            'regiao': 'BR',
            'categoria': _txt(r[0]),
            # Caixa alta sempre. A revisao de agosto traz a mesma marca em duas
            # grafias ('HYUNDAI' e 'Hyundai', 'NISSAN' e 'Nissan'), e quem ler o
            # JSON sem normalizar acaba com a marca partida em duas.
            'marca': _txt(r[1]).upper(),
            'modelo': _txt(r[2]),
            'versao': _txt(r[3]),
            'motor': _txt(r[4]),
            'tipo': tipo,
            'combustivel': combustivel,
            'consumo': consumo,
        }
        if autonomia is not None:
            entrada['autonomia_eletrica_km'] = autonomia
        # Assinatura do irmao tecnico: mesmo motor, transmissao e emissoes.
        entrada['_sig'] = (entrada['marca'], entrada['modelo'], entrada['motor'],
                           r[6], tuple(r[idx['emissoes']]))
        registros.append(entrada)

    if corrompidos:
        proporcao = corrompidos / (len(registros) + corrompidos)
        print('  %d registros descartados por tipo ou combustivel ilegivel (%.1f%%)'
              % (corrompidos, proporcao * 100))
        if proporcao > 0.05:
            raise SystemExit(
                'ERRO: %.1f%% dos registros sairam ilegiveis, alto demais para\n'
                'ignorar. A extracao deste PDF nao esta confiavel, nada foi gravado.'
                % (proporcao * 100)
            )

    # O PDF traz celulas de consumo em branco em algumas versoes, glitch de
    # extracao. O registro irmao de mesma ficha tecnica tem os mesmos numeros.
    por_sig = {}
    for e in registros:
        por_sig.setdefault(e['_sig'], []).append(e)
    preenchidos = 0
    for e in registros:
        if e['consumo']:
            continue
        for irmao in por_sig.get(e['_sig'], []):
            if irmao is not e and irmao['consumo']:
                e['consumo'] = json.loads(json.dumps(irmao['consumo']))
                preenchidos += 1
                break
    for e in registros:
        del e['_sig']

    # O PDF repete linhas identicas; mantem a primeira ocorrencia.
    vistos, saida = set(), []
    for e in registros:
        chave = json.dumps(e, sort_keys=True, ensure_ascii=False)
        if chave in vistos:
            continue
        vistos.add(chave)
        saida.append(e)

    _conferir_sanidade_pbev(saida, pdf_path)

    vazios = [e for e in saida if not e['consumo']]
    print('  PBEV: %d registros, %d duplicados removidos, %d preenchidos a partir de irmao, %d sem consumo'
          % (len(saida), len(registros) - len(saida), preenchidos, len(vazios)))
    print('    tipos: %s' % dict(Counter(e['tipo'] for e in saida)))
    print('    combustiveis: %s' % dict(Counter(e['combustivel'] for e in saida)))
    for e in vazios[:5]:
        print('    sem consumo: %s %s %s' % (e['marca'], e['modelo'], e['versao']))
    return saida


# ══════════════════════════════════════════════════════════════════════════
#  UNIAO EUROPEIA, WLTP / VCA
# ══════════════════════════════════════════════════════════════════════════
#
# ATENCAO, esta metade NAO foi validada contra o CSV real.
#
# O gerar_dados.py original se perdeu, e o CSV da VCA nao estava no disco na
# reconstrucao de 23/09/2026. A metade PBEV acima foi recuperada de um script
# irmao e confere registro a registro com dados/pbev.json. Esta aqui foi
# deduzida a partir da forma do dados/wltp.json ja gerado.
#
# O ponto que obrigou a deducao: a coluna 'Fuel Type' NAO determina o tipo.
# No wltp.json atual, 'Petrol Electric' aparece como HEV em 651 registros e
# como ICE em 620, o que so se explica por uma coluna de powertrain separando
# hibrido cheio de mild hybrid. Por isso o tipo sai de POWERTRAIN_MAP abaixo.
#
# Como o mapeamento e deducao, esta metade FALHA ALTO quando encontra um valor
# que nao conhece, em vez de gravar dado errado em silencio. Se o primeiro uso
# reclamar, ajuste POWERTRAIN_MAP e confira o resultado contra o wltp.json
# anterior antes de substituir.

WLTP_COLUNAS = {
    'marca':       ['manufacturer', 'make'],
    'modelo':      ['model'],
    'versao':      ['description', 'variant'],
    'combustivel': ['fuel type', 'fuel'],
    'powertrain':  ['powertrain'],
    'combinado':   ['wltp metric combined', 'metric combined', 'combined (l/100km)'],
    'wh_km':       ['wh/km', 'electric energy consumption wh/km'],
    'autonomia':   ['maximum range (km)', 'electric range (km)', 'range (km)'],
}

# Ordem importa: 'plug-in hybrid' tem de ser testado antes de 'hybrid', e
# 'mild hybrid' antes de 'hybrid electric', senao o casamento parcial erra.
POWERTRAIN_MAP = [
    ('plug-in hybrid', 'PHEV'), ('phev', 'PHEV'),
    ('battery electric', 'BEV'), ('pure electric', 'BEV'), ('bev', 'BEV'),
    ('mild hybrid', 'ICE'), ('mhev', 'ICE'),   # mild hybrid conta como ICE
    ('hybrid electric', 'HEV'), ('hev', 'HEV'),
    ('internal combustion', 'ICE'), ('ice', 'ICE'),
]


def _achar_coluna(colunas, candidatos, obrigatoria=True, rotulo=''):
    norm = {str(c).strip().lower(): c for c in colunas}
    for cand in candidatos:
        if cand in norm:
            return norm[cand]
    for cand in candidatos:                      # casamento parcial
        for chave, original in norm.items():
            if cand in chave:
                return original
    if obrigatoria:
        raise SystemExit(
            'ERRO: coluna "%s" nao encontrada no CSV.\n'
            '  procurei por: %s\n'
            '  colunas do arquivo: %s\n'
            'Ajuste WLTP_COLUNAS em gerar_dados.py.'
            % (rotulo, candidatos, list(colunas))
        )
    return None


def _classificar(powertrain):
    p = str(powertrain or '').strip().lower()
    for chave, tipo in POWERTRAIN_MAP:
        if chave in p:
            return tipo
    return None


def gerar_wltp(csv_path):
    import pandas as pd

    df = pd.read_csv(csv_path, encoding='latin-1', low_memory=False)
    col = {k: _achar_coluna(df.columns, v,
                            obrigatoria=(k not in ('autonomia', 'wh_km')),
                            rotulo=k)
           for k, v in WLTP_COLUNAS.items()}

    def val(linha, chave):
        c = col.get(chave)
        if not c:
            return None
        v = linha.get(c)
        return None if pd.isna(v) else v

    def num(linha, chave):
        v = val(linha, chave)
        if v is None:
            return None
        try:
            return float(str(v).replace(',', '.'))
        except ValueError:
            return None

    registros, desconhecidos = [], Counter()
    for _, linha in df.iterrows():
        tipo = _classificar(val(linha, 'powertrain'))
        if tipo is None:
            desconhecidos[str(val(linha, 'powertrain'))] += 1
            continue

        consumo = {}
        combinado = num(linha, 'combinado')
        wh_km = num(linha, 'wh_km')
        if combinado is not None:
            # PHEV separa o consumo fossil do eletrico; ICE e HEV tem um so.
            chave = 'gasolina_combinado' if tipo == 'PHEV' else 'combinado'
            consumo[chave] = {'valor': combinado, 'unidade': 'L/100km'}
        if wh_km is not None:
            consumo['eletrico_wh_km'] = {'valor': wh_km, 'unidade': 'Wh/km'}

        autonomia = num(linha, 'autonomia')
        registros.append({
            'fonte': 'WLTP (VCA)',
            'regiao': 'EU',
            'marca': _txt(str(val(linha, 'marca') or '')),
            'modelo': _txt(str(val(linha, 'modelo') or '')),
            'versao': _txt(str(val(linha, 'versao') or '')),
            'tipo': tipo,
            'combustivel': _txt(str(val(linha, 'combustivel') or '')),
            'consumo': consumo,
            'autonomia_eletrica_km': autonomia if tipo in ('BEV', 'PHEV') else None,
        })

    if desconhecidos:
        raise SystemExit(
            'ERRO: valores de powertrain nao reconhecidos, nada foi gravado.\n'
            + ''.join('  %5d x %s\n' % (n, p) for p, n in desconhecidos.most_common())
            + 'Acrescente-os a POWERTRAIN_MAP em gerar_dados.py e rode de novo.'
        )

    vistos, saida = set(), []
    for e in registros:
        chave = json.dumps(e, sort_keys=True, ensure_ascii=False)
        if chave in vistos:
            continue
        vistos.add(chave)
        saida.append(e)

    print('  WLTP: %d registros, %d duplicados removidos'
          % (len(saida), len(registros) - len(saida)))
    print('    tipos: %s' % dict(Counter(e['tipo'] for e in saida)))
    return saida


# ══════════════════════════════════════════════════════════════════════════

def main():
    ap = argparse.ArgumentParser(
        description='Regenera os JSONs de dados oficiais do AutoCusto BR.')
    ap.add_argument('--pbev', help='PDF da tabela PBEV do Inmetro (Brasil)')
    ap.add_argument('--wltp', help='CSV Euro 6 da VCA (Uniao Europeia)')
    ap.add_argument('--out', default='./dados', help='pasta de saida (padrao: ./dados)')
    args = ap.parse_args()

    if not args.pbev and not args.wltp:
        ap.error('informe ao menos --pbev ou --wltp')

    destino = Path(args.out)
    destino.mkdir(parents=True, exist_ok=True)

    for origem, gerador, nome in ((args.pbev, gerar_pbev, 'pbev.json'),
                                  (args.wltp, gerar_wltp, 'wltp.json')):
        if not origem:
            continue
        if not Path(origem).exists():
            raise SystemExit('ERRO: arquivo nao encontrado: %s' % origem)
        print('Lendo %s' % origem)
        dados = gerador(origem)
        alvo = destino / nome
        with open(alvo, 'w', encoding='utf-8') as f:
            # indent=1 acompanha o formato ja versionado dos JSONs de dados,
            # para o diff de uma regeracao mostrar so o que mudou de fato.
            json.dump(dados, f, ensure_ascii=False, indent=1)
        print('  gravado: %s\n' % alvo)


if __name__ == '__main__':
    main()
